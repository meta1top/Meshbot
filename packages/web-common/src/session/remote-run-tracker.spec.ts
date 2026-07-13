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
      },
    });
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
