/**
 * `createRemoteSessionTransport` 的 `confirm`/`answer`/`watchSession`/
 * `interrupt` 只依赖 `@/rest/remote-agent-sessions`（REST 转发到 B）与
 * `@/rest/remote-agents`（T18/T19 观察通道 REST）两个模块——jest.mock 掉，
 * 断言调用参数即可，不需要真实网络/socket。`@/lib/socket` 的
 * `getSessionSocket()` 只在 `subscribe()` 内部才会被调用，本文件不测
 * `subscribe`，无需 mock。
 */
jest.mock("@/rest/remote-agents", () => ({
  watchRemoteAgent: jest.fn(),
  unwatchRemoteAgent: jest.fn(),
}));
jest.mock("@/rest/remote-agent-sessions", () => ({
  confirmRemote: jest.fn(),
  answerRemote: jest.fn(),
  interruptRemoteRun: jest.fn(),
  fetchRemoteSessions: jest.fn(),
  fetchRemoteHistory: jest.fn(),
  fetchRemoteRun: jest.fn(),
  fetchRemoteArtifact: jest.fn(),
  patchRemoteSessionModel: jest.fn(),
  startRemoteRun: jest.fn(),
  uploadRemoteArtifactToDrive: jest.fn(),
}));

import {
  answerRemote,
  confirmRemote,
  interruptRemoteRun,
} from "@/rest/remote-agent-sessions";
import { unwatchRemoteAgent, watchRemoteAgent } from "@/rest/remote-agents";
import { createRemoteSessionTransport } from "./session-transport";

const mockWatchRemoteAgent = watchRemoteAgent as jest.Mock;
const mockUnwatchRemoteAgent = unwatchRemoteAgent as jest.Mock;
const mockConfirmRemote = confirmRemote as jest.Mock;
const mockAnswerRemote = answerRemote as jest.Mock;
const mockInterruptRemoteRun = interruptRemoteRun as jest.Mock;

/** 让 `watchRemoteAgent()` 的 `.then()` 回调（`startAgentWatch` 内部）真正跑完
 * ——`await Promise.resolve()` 只推进一个微任务，链式 `.then` 需要再多等一轮，
 * `setImmediate` 把断言排到宏任务队列末尾，保证微任务队列已经清空。 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  mockUnwatchRemoteAgent.mockResolvedValue(undefined);
  mockConfirmRemote.mockResolvedValue({ ok: true });
  mockAnswerRemote.mockResolvedValue({ ok: true });
  mockInterruptRemoteRun.mockResolvedValue(undefined);
});

describe("web-agent 远程 transport：confirm/answer watchId 回退（Task 16b）", () => {
  it("观察者（无 streamId、REST 已拿到 session 级 watchId）调 confirm → 只带 watchId，不带 streamId", async () => {
    mockWatchRemoteAgent.mockResolvedValue({ watchId: "w1" });
    const t = createRemoteSessionTransport("agent-1");
    t.watchSession!("s1");
    await flush();

    await t.confirm(null, "s1", "tc1", "send", "编辑后的内容");

    expect(mockConfirmRemote).toHaveBeenCalledTimes(1);
    const [agentId, body] = mockConfirmRemote.mock.calls[0];
    expect(agentId).toBe("agent-1");
    expect(body).toMatchObject({
      watchId: "w1",
      sessionId: "s1",
      toolCallId: "tc1",
      decision: "send",
      content: "编辑后的内容",
    });
    expect(body).not.toHaveProperty("streamId");
  });

  it("发起方（有 streamId）调 confirm → 只带 streamId，不带 watchId（不能两个都带，即使会话同时挂着观察通道）", async () => {
    mockWatchRemoteAgent.mockResolvedValue({ watchId: "w1" });
    const t = createRemoteSessionTransport("agent-1");
    // 打开会话即 session-watch：发起方视图同样会调用 watchSession，必须验证
    // 「有 streamId 时优先用它」而不是恰好没拿到 watchId 才凑巧成立。
    t.watchSession!("s1");
    await flush();

    await t.confirm("st1", "s1", "tc1", "send");

    const [, body] = mockConfirmRemote.mock.calls[0];
    expect(body).toMatchObject({ streamId: "st1", sessionId: "s1" });
    expect(body).not.toHaveProperty("watchId");
  });

  it("answer：观察者用 watchId、发起方用 streamId，二者互斥", async () => {
    mockWatchRemoteAgent.mockResolvedValue({ watchId: "w1" });
    const t = createRemoteSessionTransport("agent-1");
    t.watchSession!("s1");
    await flush();
    const answers = [{ selected: ["A"], other: "o" }];

    await t.answer(null, "s1", "tc1", answers);
    const observed = mockAnswerRemote.mock.calls[0][1];
    expect(observed).toMatchObject({ watchId: "w1", sessionId: "s1", answers });
    expect(observed).not.toHaveProperty("streamId");

    await t.answer("st1", "s1", "tc1", answers);
    const initiated = mockAnswerRemote.mock.calls[1][1];
    expect(initiated).toMatchObject({ streamId: "st1" });
    expect(initiated).not.toHaveProperty("watchId");
  });

  it("两者都没有 → 抛错；从未 watch 过该会话（文案对应『自己发起的 run 还没就绪』）", async () => {
    const t = createRemoteSessionTransport("agent-1");
    await expect(t.confirm(null, "s1", "tc1", "send")).rejects.toThrow(
      "远程会话 streamId 未就绪，请稍候重试",
    );
    expect(mockConfirmRemote).not.toHaveBeenCalled();
  });

  it("两者都没有 → 抛错；已发起 watch 但 REST 往返未完成（文案对应『观察通道正在建立中』，与上一条不同）", async () => {
    mockWatchRemoteAgent.mockReturnValue(new Promise(() => {})); // 永不 resolve，模拟 REST 挂起窗口期
    const t = createRemoteSessionTransport("agent-1");
    t.watchSession!("s1");
    // 不 flush——watchId 仍是初始占位的 null。

    await expect(t.confirm(null, "s1", "tc1", "send")).rejects.toThrow(
      "观察通道正在建立中，请稍候重试",
    );
    expect(mockConfirmRemote).not.toHaveBeenCalled();
  });

  it("两者都没有 → 抛错；REST 建立观察通道永久失败（文案对应『建立失败，刷新重试』，与『正在建立中』是完全不同的排查线索——Minor-1，避免观察者永远被卡在『稍候重试』的假象里）", async () => {
    mockWatchRemoteAgent.mockRejectedValue(new Error("network down"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const t = createRemoteSessionTransport("agent-1");
    t.watchSession!("s1");
    await flush();

    await expect(t.confirm(null, "s1", "tc1", "send")).rejects.toThrow(
      "观察通道建立失败，请刷新页面重试",
    );
    expect(mockConfirmRemote).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("watchId 落地晚于首次读取 → 读的是『当前』值，不是 watchSession() 调用瞬间捕获的旧值", async () => {
    let resolveWatch!: (v: { watchId: string }) => void;
    mockWatchRemoteAgent.mockReturnValue(
      new Promise((resolve) => {
        resolveWatch = resolve;
      }),
    );
    const t = createRemoteSessionTransport("agent-1");
    t.watchSession!("s1");

    // REST 还没回来：此刻作答必须报「建立中」，不能读到 stale/undefined 值。
    await expect(t.confirm(null, "s1", "tc1", "send")).rejects.toThrow(
      "观察通道正在建立中，请稍候重试",
    );

    // REST 迟到落地。
    resolveWatch({ watchId: "w-late" });
    await flush();

    await t.confirm(null, "s1", "tc1", "send");
    const body = mockConfirmRemote.mock.calls[0][1];
    expect(body.watchId).toBe("w-late");
  });

  it("unwatch 后重新 watchSession（等效重连场景：组件卸载/重挂载换发新 watchId）→ 作答用的是新 watchId，旧值不残留", async () => {
    mockWatchRemoteAgent.mockResolvedValueOnce({ watchId: "w1" });
    const t = createRemoteSessionTransport("agent-1");
    const stop1 = t.watchSession!("s1");
    await flush();
    await t.confirm(null, "s1", "tc1", "send");
    expect(mockConfirmRemote.mock.calls[0][1]).toMatchObject({
      watchId: "w1",
    });

    stop1(); // 组件卸载：释放旧通道
    mockWatchRemoteAgent.mockResolvedValueOnce({ watchId: "w2" });
    t.watchSession!("s1"); // 重挂载/切回同一会话：新开一路观察
    await flush();

    await t.confirm(null, "s1", "tc1", "send");
    const second = mockConfirmRemote.mock.calls[1][1];
    expect(second.watchId).toBe("w2");
    expect(second.watchId).not.toBe("w1");
  });

  it("interrupt 不回退 watchId：无 streamId 时仍是 no-op（不调用 interruptRemoteRun），即使会话正挂着已受理的观察通道（T16 契约层三处独立禁止之一）", async () => {
    mockWatchRemoteAgent.mockResolvedValue({ watchId: "w1" });
    const t = createRemoteSessionTransport("agent-1");
    t.watchSession!("s1");
    await flush();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await t.interrupt(null, "s1");

    expect(mockInterruptRemoteRun).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
