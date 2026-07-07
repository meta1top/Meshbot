import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { RemoteRunInboundService } from "./remote-run-inbound.service";

/**
 * fake EventEmitter2：真实维护 event→handler 集合，支持 on/off/emit，
 * 让「按 sessionId 过滤」「终止后退订」等行为可被真实触发验证（而非只查调用参数）。
 */
function makeEmitter() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on: jest.fn((event: string, handler: (payload: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler);
    }),
    off: jest.fn((event: string, handler: (payload: unknown) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    emit: jest.fn((event: string, payload: unknown) => {
      for (const h of listeners.get(event) ?? []) h(payload);
    }),
  };
}

function make() {
  const sessions = {
    createSession: jest.fn().mockResolvedValue({
      sessionId: "s-new",
      session: { id: "s-new" },
    }),
    appendMessage: jest
      .fn()
      .mockResolvedValue({ messageId: "m1", queued: true }),
  };
  const runner = { kick: jest.fn() };
  const relay = { emitAgentRunFrame: jest.fn(), emitAgentRunEnd: jest.fn() };
  const account = {
    run: jest.fn(async (_uid: string, fn: () => Promise<void>) => fn()),
  };
  const emitter = makeEmitter();
  const svc = new RemoteRunInboundService(
    sessions as never,
    runner as never,
    relay as never,
    account as never,
    emitter as never,
  );
  return { svc, sessions, runner, relay, account, emitter };
}

const fwd = (over: object) => ({
  cloudUserId: "u1",
  forwarded: {
    streamId: "stream-1",
    targetDeviceId: "dB",
    requesterDeviceId: "dA",
    mode: "create",
    content: "hello",
    ...over,
  },
});

describe("RemoteRunInboundService", () => {
  describe("onAgentRunRequest", () => {
    it("mode=create → account.run 内 sessions.createSession + runner.kick(新 sessionId)", async () => {
      const { svc, sessions, runner, account } = make();
      await svc.onAgentRunRequest(fwd({}) as never);

      expect(account.run).toHaveBeenCalledWith("u1", expect.any(Function));
      expect(sessions.createSession).toHaveBeenCalledWith({
        content: "hello",
      });
      expect(runner.kick).toHaveBeenCalledWith("s-new");
    });

    it("mode=append → account.run 内 sessions.appendMessage(sessionId) + runner.kick(同 sessionId)", async () => {
      const { svc, sessions, runner } = make();
      await svc.onAgentRunRequest(
        fwd({
          mode: "append",
          sessionId: "remote-sess-1",
          content: "continue",
        }) as never,
      );

      expect(sessions.appendMessage).toHaveBeenCalledWith(
        "remote-sess-1",
        expect.objectContaining({
          messageId: expect.any(String),
          content: "continue",
        }),
      );
      expect(runner.kick).toHaveBeenCalledWith("remote-sess-1");
    });

    it("mode=append 缺 sessionId → 不 kick，回 agentRunEnd{reason:error}", async () => {
      const { svc, runner, relay } = make();
      await svc.onAgentRunRequest(
        fwd({ mode: "append", sessionId: undefined }) as never,
      );

      expect(runner.kick).not.toHaveBeenCalled();
      expect(relay.emitAgentRunEnd).toHaveBeenCalledWith("u1", {
        streamId: "stream-1",
        requesterDeviceId: "dA",
        reason: "error",
      });
    });

    it("account.run/sessions 抛错 → 不冒泡，回 agentRunEnd{reason:error}", async () => {
      const { svc, sessions, relay, runner } = make();
      sessions.createSession.mockRejectedValueOnce(new Error("boom"));

      await expect(
        svc.onAgentRunRequest(fwd({}) as never),
      ).resolves.toBeUndefined();
      expect(relay.emitAgentRunEnd).toHaveBeenCalledWith("u1", {
        streamId: "stream-1",
        requesterDeviceId: "dA",
        reason: "error",
      });
      expect(runner.kick).not.toHaveBeenCalled();
    });
  });

  describe("SESSION_WS_EVENTS 订阅转发", () => {
    it("按 sessionId 精确过滤：目标 session 的事件 → relay.emitAgentRunFrame；别的 session 不回发", async () => {
      const { svc, relay, emitter } = make();
      await svc.onAgentRunRequest(fwd({}) as never); // sessionId = s-new

      emitter.emit(SESSION_WS_EVENTS.runChunk, {
        sessionId: "s-new",
        messageId: "m1",
        delta: "hi",
      });
      emitter.emit(SESSION_WS_EVENTS.runChunk, {
        sessionId: "other-session",
        messageId: "m9",
        delta: "nope",
      });

      expect(relay.emitAgentRunFrame).toHaveBeenCalledTimes(1);
      expect(relay.emitAgentRunFrame).toHaveBeenCalledWith("u1", {
        streamId: "stream-1",
        requesterDeviceId: "dA",
        seq: 1,
        sessionId: "s-new",
        event: SESSION_WS_EVENTS.runChunk,
        payload: { sessionId: "s-new", messageId: "m1", delta: "hi" },
      });
    });

    it("seq 逐帧递增", async () => {
      const { svc, relay, emitter } = make();
      await svc.onAgentRunRequest(fwd({}) as never);

      emitter.emit(SESSION_WS_EVENTS.runHuman, { sessionId: "s-new" });
      emitter.emit(SESSION_WS_EVENTS.runChunk, {
        sessionId: "s-new",
        delta: "a",
      });
      emitter.emit(SESSION_WS_EVENTS.runChunk, {
        sessionId: "s-new",
        delta: "b",
      });

      const seqs = relay.emitAgentRunFrame.mock.calls.map(
        (c: unknown[]) => (c[1] as { seq: number }).seq,
      );
      expect(seqs).toEqual([1, 2, 3]);
    });

    it("终止事件 run.done → 回 agentRunEnd{reason:done} 并退订全部监听器", async () => {
      const { svc, relay, emitter } = make();
      await svc.onAgentRunRequest(fwd({}) as never);

      emitter.emit(SESSION_WS_EVENTS.runDone, {
        sessionId: "s-new",
        messageId: "m1",
        content: "done",
      });

      expect(relay.emitAgentRunEnd).toHaveBeenCalledWith("u1", {
        streamId: "stream-1",
        requesterDeviceId: "dA",
        reason: "done",
      });
      // 退订无泄漏：on 与 off 调用次数一致
      expect(emitter.off.mock.calls.length).toBe(emitter.on.mock.calls.length);

      // 再来同 session 的事件应不再回发（监听器已全部移除）
      relay.emitAgentRunFrame.mockClear();
      emitter.emit(SESSION_WS_EVENTS.runChunk, {
        sessionId: "s-new",
        delta: "late",
      });
      expect(relay.emitAgentRunFrame).not.toHaveBeenCalled();
    });

    it("终止事件 run.error → 回 agentRunEnd{reason:error} 并退订", async () => {
      const { svc, relay, emitter } = make();
      await svc.onAgentRunRequest(fwd({}) as never);

      emitter.emit(SESSION_WS_EVENTS.runError, {
        sessionId: "s-new",
        messageId: null,
        pendingIds: [],
        error: "boom",
      });

      expect(relay.emitAgentRunEnd).toHaveBeenCalledWith("u1", {
        streamId: "stream-1",
        requesterDeviceId: "dA",
        reason: "error",
      });
    });

    it("终止事件 run.interrupted → 回 agentRunEnd{reason:interrupted} 并退订", async () => {
      const { svc, relay, emitter } = make();
      await svc.onAgentRunRequest(fwd({}) as never);

      emitter.emit(SESSION_WS_EVENTS.runInterrupted, {
        sessionId: "s-new",
        messageId: "m1",
      });

      expect(relay.emitAgentRunEnd).toHaveBeenCalledWith("u1", {
        streamId: "stream-1",
        requesterDeviceId: "dA",
        reason: "interrupted",
      });
    });

    it("两个并行请求（不同 streamId/session）互不串台", async () => {
      const { svc, sessions, relay, emitter } = make();
      sessions.createSession
        .mockResolvedValueOnce({ sessionId: "s-1", session: { id: "s-1" } })
        .mockResolvedValueOnce({ sessionId: "s-2", session: { id: "s-2" } });

      await svc.onAgentRunRequest(
        fwd({ streamId: "stream-1", requesterDeviceId: "dA" }) as never,
      );
      await svc.onAgentRunRequest(
        fwd({ streamId: "stream-2", requesterDeviceId: "dA2" }) as never,
      );

      emitter.emit(SESSION_WS_EVENTS.runChunk, {
        sessionId: "s-1",
        delta: "for-1",
      });

      expect(relay.emitAgentRunFrame).toHaveBeenCalledTimes(1);
      expect(relay.emitAgentRunFrame).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ streamId: "stream-1", sessionId: "s-1" }),
      );
    });
  });
});
