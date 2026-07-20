/**
 * @jest-environment jsdom
 */

import type { SessionListEvent } from "@meshbot/web-common/session/session-list-events";
import type { SessionTransport } from "@meshbot/web-common/session/transport";
import { renderHook } from "@testing-library/react";
import {
  type AgentLifecycleWatchTarget,
  useRemoteAgentLifecycleWatch,
} from "./use-remote-agent-lifecycle-watch";

/** 一路假 transport 的可观测句柄：断言 watch/unwatch/dispose 调用次数，并
 * 记录 `watchAgent` 实际收到的回调（用于验证本 hook 确实传的是可安全调用的
 * 空函数，而不是漏传/传错类型）。 */
interface FakeHandle {
  watchCalls: number;
  unwatchCalls: number;
  disposeCalls: number;
  receivedCallback: ((evt: SessionListEvent) => void) | null;
}

/** `SessionTransport` 里本 hook 不使用的方法一律桩成「调用即抛错」——本 hook
 * 只碰 `watchAgent`/`dispose`，其余方法测试内一次都不该被调用，误用时要
 * 比静默返回空值更早暴露。 */
function unusedMethod<T>(): T {
  return (() => {
    throw new Error("SessionTransport 方法在本测试内不应被调用");
  }) as unknown as T;
}

/**
 * 造一个可控假 transport 工厂：`supportsWatchAgent=false` 模拟 transport 不
 * 提供 `watchAgent` 的防御性分支。`handles` 是 agentId → 句柄的映射，工厂每次
 * 被调用（每个被 watch 的 agentId 各一次）都会往里登记一条。
 */
function makeFakeTransportFactory(opts?: { supportsWatchAgent?: boolean }) {
  const supportsWatchAgent = opts?.supportsWatchAgent ?? true;
  const handles = new Map<string, FakeHandle>();

  const factory = (agentId: string): SessionTransport => {
    const handle: FakeHandle = {
      watchCalls: 0,
      unwatchCalls: 0,
      disposeCalls: 0,
      receivedCallback: null,
    };
    handles.set(agentId, handle);

    const base = {
      capabilities: { localRun: false },
      listSessions: unusedMethod(),
      fetchHistory: unusedMethod(),
      startRun: unusedMethod(),
      interrupt: unusedMethod(),
      confirm: unusedMethod(),
      answer: unusedMethod(),
      patchSessionModel: unusedMethod(),
      fetchPending: unusedMethod(),
      fetchActiveRun: unusedMethod(),
      readArtifact: unusedMethod(),
      uploadArtifactToDrive: unusedMethod(),
      subscribe: () => () => {},
      dispose: () => {
        handle.disposeCalls += 1;
      },
    } as unknown as Omit<SessionTransport, "watchAgent">;

    if (!supportsWatchAgent) return base as SessionTransport;

    return {
      ...base,
      watchAgent: (onEvent: (evt: SessionListEvent) => void) => {
        handle.watchCalls += 1;
        handle.receivedCallback = onEvent;
        return () => {
          handle.unwatchCalls += 1;
        };
      },
    };
  };

  return { factory, handles };
}

function renderWatch(
  targets: AgentLifecycleWatchTarget[],
  transportFactory: (agentId: string) => SessionTransport,
) {
  return renderHook(
    (props: { targets: AgentLifecycleWatchTarget[] }) =>
      useRemoteAgentLifecycleWatch(props.targets, transportFactory),
    { initialProps: { targets } },
  );
}

describe("useRemoteAgentLifecycleWatch", () => {
  it("已展开 + 在线 → 建立 watch，且回调是可安全调用的空函数", () => {
    const { factory, handles } = makeFakeTransportFactory();
    renderWatch([{ agentId: "a1", online: true }], factory);

    const handle = handles.get("a1");
    expect(handle?.watchCalls).toBe(1);
    // hook 不消费事件（web-agent 走全局事件总线），但传入的回调必须存在且
    // 调用它不能抛错——否则真实 transport 一旦意外触发它就会炸。
    expect(() =>
      handle?.receivedCallback?.({ type: "created" } as never),
    ).not.toThrow();
  });

  it("收起 Agent → unwatch 被调用（组件仍挂载，不是只在 unmount 时才清）", () => {
    const { factory, handles } = makeFakeTransportFactory();
    const { rerender } = renderWatch(
      [{ agentId: "a1", online: true }],
      factory,
    );
    expect(handles.get("a1")?.unwatchCalls).toBe(0);

    // 收起：targets 里不再包含 a1；组件本身不 unmount（rerender 而非 unmount）。
    rerender({ targets: [] });

    expect(handles.get("a1")?.unwatchCalls).toBe(1);
    expect(handles.get("a1")?.disposeCalls).toBe(1);
  });

  it("离线 Agent → 不建立 watch", () => {
    const { factory, handles } = makeFakeTransportFactory();
    renderWatch([{ agentId: "a1", online: false }], factory);

    expect(handles.get("a1")).toBeUndefined();
  });

  it("transport.watchAgent 不存在（undefined）→ 不抛错，安全跳过", () => {
    const { factory, handles } = makeFakeTransportFactory({
      supportsWatchAgent: false,
    });

    expect(() =>
      renderWatch([{ agentId: "a1", online: true }], factory),
    ).not.toThrow();
    expect(handles.get("a1")?.watchCalls).toBe(0);
    // 防御分支仍要把不用的 transport 释放掉，不占坑。
    expect(handles.get("a1")?.disposeCalls).toBe(1);
  });

  it("多个 Agent 各自独立，收起其中一个不影响另一个", () => {
    const { factory, handles } = makeFakeTransportFactory();
    const { rerender } = renderWatch(
      [
        { agentId: "a1", online: true },
        { agentId: "a2", online: true },
      ],
      factory,
    );

    expect(handles.get("a1")?.watchCalls).toBe(1);
    expect(handles.get("a2")?.watchCalls).toBe(1);

    // 收起 a1，保留 a2。
    rerender({ targets: [{ agentId: "a2", online: true }] });

    expect(handles.get("a1")?.unwatchCalls).toBe(1);
    expect(handles.get("a2")?.unwatchCalls).toBe(0);
  });

  it("组件卸载 → 兜底释放全部剩余通道", () => {
    const { factory, handles } = makeFakeTransportFactory();
    const { unmount } = renderWatch([{ agentId: "a1", online: true }], factory);

    expect(handles.get("a1")?.unwatchCalls).toBe(0);
    unmount();
    expect(handles.get("a1")?.unwatchCalls).toBe(1);
    expect(handles.get("a1")?.disposeCalls).toBe(1);
  });
});
