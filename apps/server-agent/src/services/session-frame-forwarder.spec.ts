import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  SessionFrameForwarder,
  type ForwardedFrame,
} from "./session-frame-forwarder";

describe("SessionFrameForwarder", () => {
  let emitter: EventEmitter2;
  let frames: ForwardedFrame[];
  let terminals: string[];

  beforeEach(() => {
    emitter = new EventEmitter2();
    frames = [];
    terminals = [];
  });

  const sink = () => ({
    onFrame: (f: ForwardedFrame) => frames.push(f),
    onTerminal: (r: "done" | "error" | "interrupted") => terminals.push(r),
  });

  it("只转发目标 sessionId 的事件（防串台）", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "a" });
    emitter.emit(SESSION_WS_EVENTS.runChunk, {
      sessionId: "OTHER",
      delta: "b",
    });
    expect(frames.map((f) => f.sessionId)).toEqual(["s1"]);
    expect(frames[0].seq).toBe(1);
  });

  it("seq 从 1 递增", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "a" });
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "b" });
    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it("subagent spawned 把子会话并入 allowedSessions，settled 移出", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "sub1", delta: "x" });
    expect(frames).toHaveLength(0); // 尚未并入

    emitter.emit(SESSION_WS_EVENTS.runSubagentSpawned, {
      sessionId: "s1",
      subSessionId: "sub1",
      toolCallId: "t1",
    });
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "sub1", delta: "y" });
    expect(frames.map((f) => f.sessionId)).toEqual(["s1", "sub1"]);

    emitter.emit(SESSION_WS_EVENTS.runSubagentSettled, {
      sessionId: "s1",
      subSessionId: "sub1",
      toolCallId: "t1",
    });
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "sub1", delta: "z" });
    expect(frames.map((f) => f.sessionId)).toEqual(["s1", "sub1", "s1"]);
  });

  it("run.tool_call_end 剥掉 content 字段", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runToolCallEnd, {
      sessionId: "s1",
      toolCallId: "t1",
      content: "巨大的文件内容",
      resultPreview: "预览",
    });
    expect(frames[0].payload).not.toHaveProperty("content");
    expect(frames[0].payload).toHaveProperty("resultPreview", "预览");
  });

  it("子会话终止事件不掐断主流", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runSubagentSpawned, {
      sessionId: "s1",
      subSessionId: "sub1",
      toolCallId: "t1",
    });
    emitter.emit(SESSION_WS_EVENTS.runDone, { sessionId: "sub1" });
    expect(terminals).toEqual([]);
    expect(fwd.active).toBe(true);
  });

  it("stopOnTerminal=true：主会话 run.done 后自动退订", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runDone, { sessionId: "s1" });
    expect(terminals).toEqual(["done"]);
    expect(fwd.active).toBe(false);
    emitter.emit(SESSION_WS_EVENTS.runChunk, {
      sessionId: "s1",
      delta: "after",
    });
    expect(
      frames.filter((f) => f.event === SESSION_WS_EVENTS.runChunk),
    ).toHaveLength(0);
  });

  it("stopOnTerminal=false（常驻）：run.done 后仍存活，跨多轮继续转发", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), false);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runDone, { sessionId: "s1" });
    expect(terminals).toEqual(["done"]);
    expect(fwd.active).toBe(true);

    // 第二轮：同一会话又开跑，帧仍然到达（这是常驻转发器与 per-run 的本质差异）
    emitter.emit(SESSION_WS_EVENTS.runChunk, {
      sessionId: "s1",
      delta: "第二轮",
    });
    expect(frames.at(-1)).toMatchObject({
      event: SESSION_WS_EVENTS.runChunk,
      sessionId: "s1",
    });
  });

  it("stop() 后不再有任何监听器残留", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), false);
    fwd.start();
    const before = emitter.listenerCount(SESSION_WS_EVENTS.runChunk);
    fwd.stop();
    expect(emitter.listenerCount(SESSION_WS_EVENTS.runChunk)).toBe(before - 1);
    expect(fwd.active).toBe(false);
  });

  it("stop() 幂等（重复调用不抛、不重复摘监听器）", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), false);
    fwd.start();
    fwd.stop();
    const after = emitter.listenerCount(SESSION_WS_EVENTS.runChunk);
    expect(() => fwd.stop()).not.toThrow();
    expect(emitter.listenerCount(SESSION_WS_EVENTS.runChunk)).toBe(after);
  });
});
