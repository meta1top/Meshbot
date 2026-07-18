/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import type { SessionSocketLike } from "./socket-like";
import type { SessionTransport } from "./transport";
import { useSessionStream } from "./use-session-stream";

/**
 * remote 分支的 `running` 生命周期回归用例（「远程会话卡死」bug）。
 *
 * 原 bug：`?streamId=` 是一次性交接参数，刷新 / 后退 / 书签重进时它是**陈旧**
 * 值（那条流早已终止），hook 却据此乐观 `setRunning(true)`，而 reclaim 探测被
 * `remoteStreamIdRef.current == null` 门住恰好跳过 → 永远等不到终止帧 →
 * running 永久 true → 停止按钮常亮 + `send()` 的 I3 守卫把用户输入静默吞掉。
 */

/** 只实现 remote 分支会触达的方法，其余按需报错——被调用即测试意图有偏差。 */
function makeTransport(
  overrides: Partial<SessionTransport> = {},
): SessionTransport {
  return {
    fetchHistory: jest.fn().mockResolvedValue({ messages: [], hasMore: false }),
    fetchActiveRun: jest.fn().mockResolvedValue(null),
    startRun: jest.fn().mockResolvedValue({ streamId: "s-new" }),
    interrupt: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SessionTransport;
}

const noopSocket: SessionSocketLike = {
  connected: true,
  on: () => undefined,
  off: () => undefined,
  emit: () => undefined,
};

// 全部 hook 入参必须跨渲染保持引用稳定：`useSessionStream` 内部多个 effect 把
// 它们放进依赖数组，每次渲染新建对象会让 effect 无限重跑（Maximum update depth）。
const scrollRef = createRef<HTMLDivElement>();
const getSocket = () => noopSocket;
const noCallbacks = {};

function renderRemoteStream(
  transport: SessionTransport,
  initialStreamId: string | null,
) {
  return renderHook(() =>
    useSessionStream(
      "sess-1",
      scrollRef,
      transport,
      getSocket,
      noCallbacks,
      "agent-1",
      initialStreamId,
    ),
  );
}

describe("useSessionStream remote 分支的 running 校正", () => {
  it("URL 带陈旧 streamId 但服务端已无活跃 run → running 校正回 false（原 bug：永久卡 true）", async () => {
    const transport = makeTransport();
    const { result } = renderRemoteStream(transport, "stale-stream");

    // 首帧仍是乐观 true（观感），随后被服务端权威结果校正。
    expect(result.current.running).toBe(true);
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(transport.fetchActiveRun).toHaveBeenCalledWith("sess-1");
    // 陈旧 streamId 一并清掉：那条流的路由早已失效。
    expect(result.current.getStreamId()).toBeNull();
  });

  it("服务端仍有活跃 run → 回填 streamId 且 running=true（刷新后也能接上停止/HITL 路由）", async () => {
    const transport = makeTransport({
      fetchActiveRun: jest.fn().mockResolvedValue({ streamId: "live-stream" }),
    });
    // 直接进入会话（URL 无 streamId）：原实现只回填 streamId、从不动 running。
    const { result } = renderRemoteStream(transport, null);

    await waitFor(() => expect(result.current.running).toBe(true));
    expect(result.current.getStreamId()).toBe("live-stream");
  });

  it("fetchActiveRun 抛错（web-main 侧协议不支持 reclaim）→ 吞掉，保持乐观值", async () => {
    const transport = makeTransport({
      fetchActiveRun: jest.fn().mockRejectedValue(new Error("unsupported")),
    });
    const { result } = renderRemoteStream(transport, "s1");

    await waitFor(() => expect(transport.fetchActiveRun).toHaveBeenCalled());
    expect(result.current.running).toBe(true);
  });

  it("running 时 send() 返回 false（调用方据此提示 + 回填），不再静默吞掉用户输入", async () => {
    const transport = makeTransport({
      fetchActiveRun: jest.fn().mockResolvedValue({ streamId: "live-stream" }),
    });
    const { result } = renderRemoteStream(transport, null);
    await waitFor(() => expect(result.current.running).toBe(true));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.send("你好");
    });

    expect(accepted).toBe(false);
    expect(transport.startRun).not.toHaveBeenCalled();
  });

  it("空闲时 send() 返回 true 并发起远程 run", async () => {
    const transport = makeTransport();
    const { result } = renderRemoteStream(transport, null);
    await waitFor(() => expect(result.current.running).toBe(false));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.send("你好");
    });

    expect(accepted).toBe(true);
    expect(transport.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "append", sessionId: "sess-1" }),
    );
    expect(result.current.running).toBe(true);
  });
});
