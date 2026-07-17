import type { AgentRunEnd, AgentRunFrame } from "@meshbot/types";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { REMOTE_SHADOW_FRAME_EVENT } from "../ws/session-shadow.events";
import { RemoteRunService } from "./remote-run.service";

/** 构造被测服务：fake relay（记录出站调用）+ fake emitter（记录本地总线重发）。 */
function make() {
  const relay = {
    emitAgentRunStart: jest.fn(),
    emitAgentRunControl: jest.fn(),
  };
  const emitter = { emit: jest.fn() };
  const svc = new RemoteRunService(relay as never, emitter as never);
  return { svc, relay, emitter };
}

/** 构造一帧运行帧，streamId/sessionId/event/payload 可覆盖。 */
function makeFrame(overrides: Partial<AgentRunFrame> = {}): AgentRunFrame {
  return {
    streamId: "stream-1",
    requesterDeviceId: "dA",
    seq: 1,
    sessionId: "remote-sess-1",
    event: SESSION_WS_EVENTS.runChunk,
    payload: { sessionId: "remote-sess-1", messageId: "m1", delta: "hi" },
    ...overrides,
  };
}

describe("RemoteRunService", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe("startRun", () => {
    it("生成 streamId、登记订阅、经 relay 下发 agentRunStart", () => {
      const { svc, relay } = make();
      const { streamId } = svc.startRun("u1", "dB", "create", null, "hello");

      expect(typeof streamId).toBe("string");
      expect(streamId.length).toBeGreaterThan(0);
      expect(relay.emitAgentRunStart).toHaveBeenCalledWith("u1", {
        streamId,
        targetAgentId: "dB",
        mode: "create",
        sessionId: undefined,
        content: "hello",
      });
    });

    it("append 模式透传已知 sessionId（B 上已存在的会话 id）", () => {
      const { svc, relay } = make();
      svc.startRun("u1", "dB", "append", "remote-sess-1", "continue");

      expect(relay.emitAgentRunStart).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ mode: "append", sessionId: "remote-sess-1" }),
      );
    });

    it("每次调用生成不同 streamId", () => {
      const { svc } = make();
      const a = svc.startRun("u1", "dB", "create", null, "a");
      const b = svc.startRun("u1", "dB", "create", null, "b");
      expect(a.streamId).not.toBe(b.streamId);
    });

    it("I3：append 模式同 (device,session) 已有活跃 run → 第二次 startRun 抛 409 拒绝", () => {
      const { svc, relay } = make();
      svc.startRun("u1", "dB", "append", "remote-sess-1", "first");
      relay.emitAgentRunStart.mockClear();

      expect(() =>
        svc.startRun("u1", "dB", "append", "remote-sess-1", "second"),
      ).toThrow();
      // 拒绝发生在生成 streamId / 下发 relay 之前，不应有第二次出站
      expect(relay.emitAgentRunStart).not.toHaveBeenCalled();
    });

    it("I3：不同 sessionId 或不同 targetAgentId 不受占用影响，可正常发起", () => {
      const { svc, relay } = make();
      svc.startRun("u1", "dB", "append", "remote-sess-1", "first");
      relay.emitAgentRunStart.mockClear();

      expect(() =>
        svc.startRun("u1", "dB", "append", "remote-sess-2", "other session"),
      ).not.toThrow();
      expect(() =>
        svc.startRun("u1", "dC", "append", "remote-sess-1", "other device"),
      ).not.toThrow();
      expect(relay.emitAgentRunStart).toHaveBeenCalledTimes(2);
    });

    it("I3：活跃 run 结束（onEnd）后，同 (device,session) 可再次发起", () => {
      const { svc, relay } = make();
      const { streamId } = svc.startRun(
        "u1",
        "dB",
        "append",
        "remote-sess-1",
        "first",
      );

      svc.onEnd({ streamId, requesterDeviceId: "dA", reason: "done" });

      expect(() =>
        svc.startRun("u1", "dB", "append", "remote-sess-1", "second"),
      ).not.toThrow();
      expect(relay.emitAgentRunStart).toHaveBeenCalledTimes(2);
    });

    it("I3：create 模式首帧到达确认 B 侧 sessionId 后，同 session 的 append 也会被占用槽位拒绝", () => {
      const { svc, relay } = make();
      const { streamId } = svc.startRun("u1", "dB", "create", null, "hi");
      svc.onFrame(makeFrame({ streamId, sessionId: "remote-sess-1" }));
      relay.emitAgentRunStart.mockClear();

      expect(() =>
        svc.startRun("u1", "dB", "append", "remote-sess-1", "second"),
      ).toThrow();
      expect(relay.emitAgentRunStart).not.toHaveBeenCalled();
    });
  });

  describe("onFrame（影子渲染）", () => {
    it("streamId 已登记 → 包成 REMOTE_SHADOW_FRAME_EVENT 重发本地总线（不复用原始事件名）", () => {
      const { svc, emitter } = make();
      const { streamId } = svc.startRun("u1", "dB", "create", null, "hi");
      const frame = makeFrame({ streamId });

      svc.onFrame(frame);

      expect(emitter.emit).toHaveBeenCalledWith(REMOTE_SHADOW_FRAME_EVENT, {
        event: frame.event,
        payload: frame.payload,
      });
      // 关键防回归断言：绝不能直接用原始事件名重发到共享总线——那会撞上
      // RunnerService.onToolCallEnd 等按事件名订阅的本地落库副作用，污染
      // A 本地 DB（I1）。
      expect(emitter.emit).not.toHaveBeenCalledWith(
        frame.event,
        expect.anything(),
      );
    });

    it("未知 streamId → 忽略，不 emit", () => {
      const { svc, emitter } = make();
      svc.onFrame(makeFrame({ streamId: "never-registered" }));

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe("onEnd", () => {
    it("清理订阅：清理后同 streamId 再来帧 → 视为未知，不再重发", () => {
      const { svc, emitter } = make();
      const { streamId } = svc.startRun("u1", "dB", "create", null, "hi");

      svc.onEnd({ streamId, requesterDeviceId: "dA", reason: "done" });

      emitter.emit.mockClear();
      svc.onFrame(makeFrame({ streamId }));
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("未知 streamId → no-op（不抛）", () => {
      const { svc } = make();
      const end: AgentRunEnd = {
        streamId: "nope",
        requesterDeviceId: "dA",
        reason: "offline",
      };
      expect(() => svc.onEnd(end)).not.toThrow();
    });

    it("【Bug #13】append 模式二次门控拒绝（从未收到过帧）→ 补发影子 run.error 带 reason，前端才不会 running 卡死 + 消息凭空消失", () => {
      const { svc, emitter } = make();
      // append 模式一开始就带已知 sessionId（register 时写入 entry.sessionId），
      // 但 onFrame 从未被调用过——模拟 B 侧二次门控在建会话/转发任何帧之前
      // 直接拒绝的场景。
      const { streamId } = svc.startRun(
        "u1",
        "dB",
        "append",
        "remote-sess-1",
        "hello",
      );

      svc.onEnd({
        streamId,
        requesterDeviceId: "dA",
        reason: "agent_not_remotable",
      });

      expect(emitter.emit).toHaveBeenCalledWith(REMOTE_SHADOW_FRAME_EVENT, {
        event: SESSION_WS_EVENTS.runError,
        payload: expect.objectContaining({
          sessionId: "remote-sess-1",
          messageId: null,
          pendingIds: [],
          reason: "agent_not_remotable",
        }),
      });
    });

    it("已收到过至少一帧（正常终止 done/error/interrupted）→ 不重复补发，B 侧转发的真实终止帧已经够了", () => {
      const { svc, emitter } = make();
      const { streamId } = svc.startRun(
        "u1",
        "dB",
        "append",
        "remote-sess-1",
        "hello",
      );
      svc.onFrame(
        makeFrame({
          streamId,
          sessionId: "remote-sess-1",
          event: SESSION_WS_EVENTS.runDone,
          payload: {
            sessionId: "remote-sess-1",
            messageId: "m1",
            content: "hi",
          },
        }),
      );
      emitter.emit.mockClear();

      svc.onEnd({ streamId, requesterDeviceId: "dA", reason: "done" });

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("create 模式二次门控拒绝、sessionId 未知（首帧从未到达）→ 无房间可发，静默清理不 emit", () => {
      const { svc, emitter } = make();
      const { streamId } = svc.startRun("u1", "dB", "create", null, "hello");
      emitter.emit.mockClear();

      svc.onEnd({
        streamId,
        requesterDeviceId: "dA",
        reason: "agent_not_remotable",
      });

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe("sendControl", () => {
    it("调 relay.emitAgentRunControl 下发控制指令", () => {
      const { svc, relay } = make();
      const control = {
        streamId: "stream-1",
        targetAgentId: "dB",
        sessionId: "remote-sess-1",
        kind: "interrupt" as const,
      };

      svc.sendControl("u1", control);

      expect(relay.emitAgentRunControl).toHaveBeenCalledWith("u1", control);
    });
  });

  describe("idle 超时", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it("90s 内无新帧 → 清理订阅 + 已知 sessionId 时发本地 run.error 收尾", () => {
      const { svc, emitter } = make();
      const { streamId } = svc.startRun("u1", "dB", "create", null, "hi");
      // 首帧带来 B 侧 sessionId，并续期一次 idle 计时
      svc.onFrame(makeFrame({ streamId, sessionId: "remote-sess-1" }));
      emitter.emit.mockClear();

      jest.advanceTimersByTime(90_000);

      expect(emitter.emit).toHaveBeenCalledWith(REMOTE_SHADOW_FRAME_EVENT, {
        event: SESSION_WS_EVENTS.runError,
        payload: expect.objectContaining({ sessionId: "remote-sess-1" }),
      });

      // 清理后旧 streamId 的帧应被忽略
      emitter.emit.mockClear();
      svc.onFrame(makeFrame({ streamId, sessionId: "remote-sess-1" }));
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("create 模式下首帧从未到达（sessionId 未知）→ 超时静默清理，不 emit run.error", () => {
      const { svc, emitter } = make();
      svc.startRun("u1", "dB", "create", null, "hi");

      jest.advanceTimersByTime(90_000);

      expect(emitter.emit).not.toHaveBeenCalledWith(
        REMOTE_SHADOW_FRAME_EVENT,
        expect.objectContaining({ event: SESSION_WS_EVENTS.runError }),
      );
    });

    it("收到新帧会续期 idle 计时（累计超过阈值但距最近一帧未超时 → 不清理）", () => {
      const { svc, emitter } = make();
      const { streamId } = svc.startRun("u1", "dB", "create", null, "hi");

      jest.advanceTimersByTime(60_000);
      svc.onFrame(makeFrame({ streamId })); // 续期
      jest.advanceTimersByTime(60_000); // 累计 120s，但距上一帧仅 60s < 90s

      emitter.emit.mockClear();
      svc.onFrame(makeFrame({ streamId }));
      expect(emitter.emit).toHaveBeenCalledWith(REMOTE_SHADOW_FRAME_EVENT, {
        event: SESSION_WS_EVENTS.runChunk,
        payload: expect.anything(),
      });
    });
  });

  describe("findRunByStreamId", () => {
    it("命中返回 {streamId, sessionId}", () => {
      const { svc } = make();
      const { streamId } = svc.startRun("u1", "dB", "create", null, "hi");
      expect(svc.findRunByStreamId(streamId)).toEqual({
        streamId,
        sessionId: null,
      });
    });

    it("未知返 null", () => {
      const { svc } = make();
      expect(svc.findRunByStreamId("nope")).toBeNull();
    });
  });

  describe("findRunBySession", () => {
    it("create 首帧回填 sessionId 后可按 session 反查 streamId", () => {
      const { svc } = make();
      const { streamId } = svc.startRun("u1", "dB", "create", null, "hi");
      svc.onFrame({
        streamId,
        sessionId: "sess-9",
        seq: 0,
        event: "run.started",
        payload: { sessionId: "sess-9" },
      } as any);
      expect(svc.findRunBySession("dB", "sess-9")).toEqual({
        streamId,
        sessionId: "sess-9",
      });
    });

    it("未知返 null", () => {
      const { svc } = make();
      expect(svc.findRunBySession("dB", "no-sess")).toBeNull();
    });
  });
});
