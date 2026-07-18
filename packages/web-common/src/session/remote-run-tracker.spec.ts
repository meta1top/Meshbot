import type { AgentRunEnd, AgentRunFrame } from "@meshbot/types";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { RemoteRunTracker } from "./remote-run-tracker";

function frame(over: Partial<AgentRunFrame> = {}): AgentRunFrame {
  return {
    streamId: "s1",
    requesterDeviceId: "user:sock1",
    seq: 1,
    sessionId: "sess-1",
    event: SESSION_WS_EVENTS.runChunk,
    payload: {},
    ...over,
  };
}

function end(over: Partial<AgentRunEnd> = {}): AgentRunEnd {
  return {
    streamId: "s1",
    requesterDeviceId: "user:sock1",
    reason: "done",
    ...over,
  };
}

describe("RemoteRunTracker", () => {
  it("未 register 的 streamId → handleFrame 忽略（返回空数组）", () => {
    const t = new RemoteRunTracker();
    expect(t.handleFrame(frame({ streamId: "foreign" }))).toEqual([]);
  });

  it("未 register 的 streamId → handleEnd 忽略（返回 null）", () => {
    const t = new RemoteRunTracker();
    expect(t.handleEnd(end({ streamId: "foreign" }))).toBeNull();
  });

  it("已 register 的流：乱序帧经内部 FrameSequencer 归位", () => {
    const t = new RemoteRunTracker();
    t.register("s1", "sess-1");
    expect(t.handleFrame(frame({ seq: 2, payload: "b" }))).toEqual([]); // seq=2 先到，缓冲等待 seq=1
    expect(t.handleFrame(frame({ seq: 1, payload: "a" }))).toEqual([
      { event: SESSION_WS_EVENTS.runChunk, payload: "a" },
      { event: SESSION_WS_EVENTS.runChunk, payload: "b" },
    ]);
  });

  it("两条不同 streamId 的流互不干扰重排状态", () => {
    const t = new RemoteRunTracker();
    t.register("s1", "sess-1");
    t.register("s2", "sess-2");
    expect(
      t.handleFrame(frame({ streamId: "s2", seq: 1, payload: "x" })),
    ).toEqual([{ event: SESSION_WS_EVENTS.runChunk, payload: "x" }]);
    // s1 从未收到帧，仍从 seq=1 开始
    expect(
      t.handleFrame(frame({ streamId: "s1", seq: 1, payload: "y" })),
    ).toEqual([{ event: SESSION_WS_EVENTS.runChunk, payload: "y" }]);
  });

  it("create 模式：首帧到达前 sessionId 未知，首帧回填", () => {
    const t = new RemoteRunTracker();
    t.register("s1", null);
    t.handleFrame(frame({ seq: 1, sessionId: "new-sess" }));
    // 首帧已到达 → handleEnd 不再合成收尾事件（真实终止信号已随过程帧送达）
    expect(t.handleEnd(end({ reason: "done" }))).toBeNull();
  });

  it("已收到过程帧的流 end → 只清理，不合成事件；owns 变为 false", () => {
    const t = new RemoteRunTracker();
    t.register("s1", "sess-1");
    t.handleFrame(frame({ seq: 1, event: SESSION_WS_EVENTS.runDone }));
    expect(t.owns("s1")).toBe(true);
    expect(t.handleEnd(end({ reason: "done" }))).toBeNull();
    expect(t.owns("s1")).toBe(false);
  });

  it("从未收到过程帧的流 end(reason=offline) → 合成 run.error（sessionId 已知）", () => {
    const t = new RemoteRunTracker();
    t.register("s1", "sess-1");
    const result = t.handleEnd(end({ reason: "offline" }));
    expect(result).toEqual({
      event: SESSION_WS_EVENTS.runError,
      payload: {
        sessionId: "sess-1",
        messageId: null,
        pendingIds: [],
        error: expect.any(String),
        // 结构化 reason 一并透传：渲染层据此走 next-intl 专属文案，
        // 而不是展示上面那条硬编码中文兜底。
        reason: "offline",
      },
    });
  });

  it("end(reason=session_agent_mismatch) → 合成 run.error 且 reason 原样透传（与 agent_not_remotable 区分开）", () => {
    const t = new RemoteRunTracker();
    t.register("s1", "sess-1");
    const result = t.handleEnd(end({ reason: "session_agent_mismatch" }));
    expect((result?.payload as { reason: string; error: string }).reason).toBe(
      "session_agent_mismatch",
    );
    expect((result?.payload as { error: string }).error).toContain(
      "该会话不属于所选 Agent",
    );
  });

  it("从未收到过程帧且 sessionId 未知（create 模式尚无首帧）→ 无法路由，返回 null", () => {
    const t = new RemoteRunTracker();
    t.register("s1", null);
    expect(t.handleEnd(end({ reason: "offline" }))).toBeNull();
  });

  it("end 后清理：重复 end（第二次已被清理）→ 返回 null", () => {
    const t = new RemoteRunTracker();
    t.register("s1", "sess-1");
    t.handleEnd(end({ reason: "offline" }));
    expect(t.handleEnd(end({ reason: "offline" }))).toBeNull();
  });

  it("release 主动清理后，该 streamId 的帧/end 均被忽略", () => {
    const t = new RemoteRunTracker();
    t.register("s1", "sess-1");
    t.release("s1");
    expect(t.owns("s1")).toBe(false);
    expect(t.handleFrame(frame())).toEqual([]);
    expect(t.handleEnd(end())).toBeNull();
  });

  it("reset 清空全部登记，此后任何已注册 streamId 均被忽略", () => {
    const t = new RemoteRunTracker();
    t.register("s1", "sess-1");
    t.register("s2", "sess-2");
    t.reset();
    expect(t.owns("s1")).toBe(false);
    expect(t.owns("s2")).toBe(false);
    expect(t.handleFrame(frame({ streamId: "s1" }))).toEqual([]);
    expect(t.handleEnd(end({ streamId: "s2" }))).toBeNull();
  });

  it("reset 后可重新 register 同一 streamId，行为等同全新实例", () => {
    const t = new RemoteRunTracker();
    t.register("s1", "sess-1");
    t.handleFrame(frame({ seq: 1 }));
    t.reset();
    t.register("s1", "sess-1");
    // 重排状态也随之清空：重新从 seq=1 开始，不会被旧状态判定为重复丢弃
    expect(t.handleFrame(frame({ seq: 1, payload: "fresh" }))).toEqual([
      { event: SESSION_WS_EVENTS.runChunk, payload: "fresh" },
    ]);
  });
});

describe("RemoteRunTracker：watchId 通道", () => {
  const frame = (over: Record<string, unknown>) =>
    ({
      requesterDeviceId: "d",
      seq: 1,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: { sessionId: "s1", delta: "x" },
      ...over,
    }) as never;

  it("未登记的 watchId 帧被忽略（不是本实例观察的）", () => {
    const t = new RemoteRunTracker();
    expect(t.handleFrame(frame({ watchId: "未登记" }))).toEqual([]);
  });

  it("已登记的 watchId 帧被吐出（中途接入，seq 非 1 也能吐）", () => {
    const t = new RemoteRunTracker();
    t.registerWatch("w1", "s1");
    expect(t.handleFrame(frame({ watchId: "w1", seq: 47 }))).toEqual([
      {
        event: SESSION_WS_EVENTS.runChunk,
        payload: { sessionId: "s1", delta: "x" },
      },
    ]);
  });

  it("watch 通道跨多轮存活（run.done 后不自动注销）", () => {
    const t = new RemoteRunTracker();
    t.registerWatch("w1", "s1");
    t.handleFrame(
      frame({ watchId: "w1", seq: 1, event: SESSION_WS_EVENTS.runDone }),
    );
    expect(t.ownsWatch("w1")).toBe(true);
    expect(t.handleFrame(frame({ watchId: "w1", seq: 2 }))).toHaveLength(1);
  });

  it("releaseWatch 后不再吐帧", () => {
    const t = new RemoteRunTracker();
    t.registerWatch("w1", "s1");
    t.releaseWatch("w1");
    expect(t.ownsWatch("w1")).toBe(false);
    expect(t.handleFrame(frame({ watchId: "w1" }))).toEqual([]);
  });

  it("D6 抑制：同一客户端已持有该 session 的 stream 时，watch 帧被丢弃（不收双份）", () => {
    const t = new RemoteRunTracker();
    t.register("st1", "s1"); // 自己发起的 run
    t.registerWatch("w1", "s1"); // 同时也在观察同一会话
    expect(t.handleFrame(frame({ watchId: "w1" }))).toEqual([]);
    expect(t.handleFrame(frame({ streamId: "st1" }))).toHaveLength(1);
  });

  it("D6 抑制解除：自己的 stream 结束后 watch 帧恢复吐出", () => {
    const t = new RemoteRunTracker();
    t.register("st1", "s1");
    t.registerWatch("w1", "s1");
    t.handleEnd({
      streamId: "st1",
      requesterDeviceId: "d",
      reason: "done",
    } as never);
    expect(t.handleFrame(frame({ watchId: "w1", seq: 5 }))).toHaveLength(1);
  });

  it("watch 先活跃、后被自己的 stream 抑制：解除后不卡死（抑制期吃帧但记账）", () => {
    const t = new RemoteRunTracker();
    t.registerWatch("w1", "s1");
    // watch 先跑起来并 prime 过（中途接入，首帧 seq=10）
    expect(t.handleFrame(frame({ watchId: "w1", seq: 10 }))).toHaveLength(1);
    // 用户接着自己发消息 → 同一 session 起了 stream → 进入 D6 抑制
    t.register("st1", "s1");
    expect(t.handleFrame(frame({ watchId: "w1", seq: 11 }))).toEqual([]);
    expect(t.handleFrame(frame({ watchId: "w1", seq: 12 }))).toEqual([]);
    t.handleEnd({
      streamId: "st1",
      requesterDeviceId: "d",
      reason: "done",
    } as never);
    // 抑制解除后必须立刻恢复吐出。若抑制期直接 return[] 跳过 sequencer，
    // nextExpectedSeq 会冻结在 11，此处 seq=13 被判乱序塞进缓冲、永久卡死。
    expect(t.handleFrame(frame({ watchId: "w1", seq: 13 }))).toHaveLength(1);
    expect(t.handleFrame(frame({ watchId: "w1", seq: 14 }))).toHaveLength(1);
  });

  it("抑制只针对同一 sessionId，别的会话的 watch 帧不受影响", () => {
    const t = new RemoteRunTracker();
    t.register("st1", "s1");
    t.registerWatch("w2", "s2");
    expect(
      t.handleFrame(
        frame({ watchId: "w2", sessionId: "s2", payload: { sessionId: "s2" } }),
      ),
    ).toHaveLength(1);
  });

  it("reset 清空 stream 与 watch 两类登记", () => {
    const t = new RemoteRunTracker();
    t.register("st1", "s1");
    t.registerWatch("w1", "s2");
    t.reset();
    expect(t.owns("st1")).toBe(false);
    expect(t.ownsWatch("w1")).toBe(false);
  });

  it("resetWatches 只清 watch 不动 stream", () => {
    const t = new RemoteRunTracker();
    t.register("st1", "s1");
    t.registerWatch("w1", "s2");
    t.resetWatches();
    expect(t.ownsWatch("w1")).toBe(false);
    // stream 登记必须原样保留——断线重连不应打断用户自己正在跑的 run。
    expect(t.owns("st1")).toBe(true);
    expect(
      t.handleFrame(frame({ streamId: "st1", sessionId: "s1" })),
    ).toHaveLength(1);
  });

  it("既有 streamId 行为零变化（回归）", () => {
    const t = new RemoteRunTracker();
    t.register("st1", null);
    expect(t.handleFrame(frame({ streamId: "st1" }))).toHaveLength(1);
    expect(
      t.handleEnd({
        streamId: "st1",
        requesterDeviceId: "d",
        reason: "done",
      } as never),
    ).toBeNull();
    expect(t.owns("st1")).toBe(false);
  });
});
