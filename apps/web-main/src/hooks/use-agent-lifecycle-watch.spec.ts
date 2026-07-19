/**
 * @jest-environment jsdom
 */

// jest.mock 工厂限制：只能引用以 `mock` 开头的外部变量（同
// `session-transport.spec.ts` 对 `./im-socket` 的 mock 手法）。
//
// 不真的挂载 `QueryClientProvider`，改为直接 mock `useQueryClient` 返回测试
// 自己 new 出来的真实 `QueryClient` 实例——排查过：本仓 `node_modules/
// @tanstack/react-query/node_modules/react`（19.2.0）与根 `node_modules/react`
// （19.2.5）是两份不同版本的物理拷贝（`pnpm why react` 显示由 workspace 内
// `apps/mobile`/expo 引入的 react 版本冲突所致，pnpm 据此为
// `@tanstack/react-query` 装了一份私有嵌套 react）。真挂载
// `QueryClientProvider` 时，其组件体内部 `useEffect` 走的是那份嵌套 react，
// 与 `@testing-library/react` 渲染时设置 dispatcher 的根 react 不是同一个
// 模块实例，触发经典 dual package hazard（`Cannot read properties of null
// (reading 'useEffect')`，`npx jest` 实测复现，非猜测）。本 hook 只调用
// `queryClient.setQueryData`/`getQueryData`（纯缓存读写，不依赖 React
// context 树），mock 掉 provider 层不影响验证的真实性——`QueryClient`
// 本身仍是 `jest.requireActual` 的真实实现，缓存行为不打折扣。
let mockCurrentClient: import("@tanstack/react-query").QueryClient | undefined;
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => mockCurrentClient,
  };
});

import type { SessionSummary } from "@meshbot/types-agent";
import type { SessionListEvent } from "@meshbot/web-common/session/session-list-events";
import type { SessionTransport } from "@meshbot/web-common/session/transport";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import {
  type AgentLifecycleWatchTarget,
  useAgentLifecycleWatch,
} from "./use-agent-lifecycle-watch";
import { remoteSessionsQueryKey } from "./use-remote-sessions";

/** 一路假 transport 的可观测句柄：断言 watch/unwatch/dispose 调用次数，并
 * 主动 `emit` 一条生命周期事件模拟设备侧镜像帧到达。 */
interface FakeHandle {
  watchCalls: number;
  unwatchCalls: number;
  disposeCalls: number;
  emit: (evt: SessionListEvent) => void;
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
 * 造一个可控假 transport 工厂：`supportsWatchAgent=false` 模拟 web-agent
 * 侧（T19 之前）不提供 `watchAgent` 的情形。`handles` 是 agentId → 句柄的
 * 映射，工厂每次被调用（每个被 watch 的 agentId 各一次）都会往里登记一条。
 */
function makeFakeTransportFactory(opts?: { supportsWatchAgent?: boolean }) {
  const supportsWatchAgent = opts?.supportsWatchAgent ?? true;
  const handles = new Map<string, FakeHandle>();

  const factory = (agentId: string): SessionTransport => {
    let listener: ((evt: SessionListEvent) => void) | null = null;
    const handle: FakeHandle = {
      watchCalls: 0,
      unwatchCalls: 0,
      disposeCalls: 0,
      emit: (evt) => listener?.(evt),
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
        listener = onEvent;
        return () => {
          handle.unwatchCalls += 1;
        };
      },
    };
  };

  return { factory, handles };
}

const s = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: `会话${id}`,
  status: "idle",
  pinned: false,
  pinnedAt: null,
  titleGenerated: false,
  modelConfigId: null,
  agentId: "a1",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  ...over,
});

function renderWithClient(
  targets: AgentLifecycleWatchTarget[],
  transportFactory: (agentId: string) => SessionTransport,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mockCurrentClient = queryClient;
  const view = renderHook(
    (props: { targets: AgentLifecycleWatchTarget[] }) =>
      useAgentLifecycleWatch(props.targets, transportFactory),
    { initialProps: { targets } },
  );
  return { queryClient, ...view };
}

describe("useAgentLifecycleWatch", () => {
  it("展开的在线 Agent → 建立 watch；收到 created 事件 → 该 agent 的缓存里多出这条会话", () => {
    const { factory, handles } = makeFakeTransportFactory();
    const { queryClient } = renderWithClient(
      [{ agentId: "a1", online: true }],
      factory,
    );

    expect(handles.get("a1")?.watchCalls).toBe(1);

    act(() => {
      handles.get("a1")?.emit({ type: "created", session: s("s1") });
    });

    expect(queryClient.getQueryData(remoteSessionsQueryKey("a1"))).toEqual([
      s("s1"),
    ]);
  });

  it("收起 Agent → unwatch 被调用（组件仍挂载，不是只在 unmount 时才清）", () => {
    const { factory, handles } = makeFakeTransportFactory();
    const { rerender } = renderWithClient(
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
    renderWithClient([{ agentId: "a1", online: false }], factory);

    expect(handles.get("a1")).toBeUndefined();
  });

  it("transport.watchAgent 不存在（undefined）→ 不抛错，安全跳过", () => {
    const { factory, handles } = makeFakeTransportFactory({
      supportsWatchAgent: false,
    });

    expect(() =>
      renderWithClient([{ agentId: "a1", online: true }], factory),
    ).not.toThrow();
    expect(handles.get("a1")?.watchCalls).toBe(0);
  });

  it("事件只影响对应 agentId 的缓存，不串到别的 agent", () => {
    const { factory, handles } = makeFakeTransportFactory();
    const { queryClient } = renderWithClient(
      [
        { agentId: "a1", online: true },
        { agentId: "a2", online: true },
      ],
      factory,
    );

    act(() => {
      handles.get("a1")?.emit({ type: "created", session: s("s1") });
    });

    expect(queryClient.getQueryData(remoteSessionsQueryKey("a1"))).toEqual([
      s("s1"),
    ]);
    expect(
      queryClient.getQueryData(remoteSessionsQueryKey("a2")),
    ).toBeUndefined();
  });
});
