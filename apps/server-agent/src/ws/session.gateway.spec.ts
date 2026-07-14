import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type { Socket } from "socket.io";
import { SessionGateway } from "./session.gateway";

function fakeSocket(): Socket & { joined: string[]; emitted: unknown[] } {
  const joined: string[] = [];
  const emitted: unknown[] = [];
  return {
    joined,
    emitted,
    data: { user: { sub: "u1" }, traceId: "t1" },
    join: (room: string) => joined.push(room),
    emit: (...args: unknown[]) => emitted.push(args),
  } as never;
}

describe("SessionGateway", () => {
  it("subscribe：join 房间，非落库轮发一次全量 run.snapshot（SET 语义）", () => {
    const runner = {
      getInflight: () => ({
        messageId: "m1",
        content: "部分",
        reasoning: "想",
        reasoningStartedAt: 1234,
        // 本轮 args 流到一半的工具调用：必须原样进快照，中途订阅者才接得上流
        toolCalls: [
          {
            toolCallId: "tc-1",
            name: "write_file",
            argsText: '{"path":"a.txt","con',
          },
        ],
        status: "streaming" as const,
      }),
      interrupt: jest.fn(),
    };
    const gw = new SessionGateway({} as never, runner as never);
    const sock = fakeSocket();
    gw.handleSubscribe({ sessionId: "s1" }, sock);
    expect(sock.joined).toEqual(["s1"]);
    expect(sock.emitted).toHaveLength(1);
    expect(sock.emitted[0]).toEqual([
      SESSION_WS_EVENTS.runSnapshot,
      {
        sessionId: "s1",
        messageId: "m1",
        reasoning: "想",
        content: "部分",
        reasoningStartedAt: 1234,
        toolCalls: [
          {
            toolCallId: "tc-1",
            name: "write_file",
            argsText: '{"path":"a.txt","con',
          },
        ],
      },
    ]);
  });

  it("subscribe：已落库轮（inflight messageId 为 null）不发 snapshot", () => {
    const runner = {
      getInflight: () => ({
        messageId: null,
        content: "部分内容",
        status: "streaming" as const,
      }),
      interrupt: jest.fn(),
    };
    const gw = new SessionGateway({} as never, runner as never);
    const sock = fakeSocket();
    gw.handleSubscribe({ sessionId: "s1" }, sock);
    expect(sock.emitted).toHaveLength(0);
  });

  it("subscribe：无 inflight 不回推", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    const sock = fakeSocket();
    gw.handleSubscribe({ sessionId: "s1" }, sock);
    expect(sock.emitted).toHaveLength(0);
  });

  it("interrupt：调 runner.interrupt", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    gw.handleInterrupt({ sessionId: "s1" });
    expect(runner.interrupt).toHaveBeenCalledWith("s1");
  });

  it("onRunChunk：把事件转发到对应房间", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    const toEmit: unknown[] = [];
    (gw as unknown as { server: unknown }).server = {
      to: () => ({ emit: (...a: unknown[]) => toEmit.push(a) }),
    };
    gw.onRunChunk({ sessionId: "s1", messageId: "m1", delta: "x" });
    expect(toEmit).toHaveLength(1);
    expect(toEmit[0]).toEqual([
      SESSION_WS_EVENTS.runChunk,
      { sessionId: "s1", messageId: "m1", delta: "x" },
    ]);
  });

  it("onRunDone：把事件转发到对应房间", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    const toEmit: unknown[] = [];
    (gw as unknown as { server: unknown }).server = {
      to: () => ({ emit: (...a: unknown[]) => toEmit.push(a) }),
    };
    const payload = { sessionId: "s1", messageId: "m1", content: "完整回复" };
    gw.onRunDone(payload);
    expect(toEmit[0]).toEqual([SESSION_WS_EVENTS.runDone, payload]);
  });

  it("onRunInterrupted：把事件转发到对应房间", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    const toEmit: unknown[] = [];
    (gw as unknown as { server: unknown }).server = {
      to: () => ({ emit: (...a: unknown[]) => toEmit.push(a) }),
    };
    const payload = { sessionId: "s1", messageId: "m1" };
    gw.onRunInterrupted(payload);
    expect(toEmit[0]).toEqual([SESSION_WS_EVENTS.runInterrupted, payload]);
  });

  it("onRunError：把事件转发到对应房间", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    const toEmit: unknown[] = [];
    (gw as unknown as { server: unknown }).server = {
      to: () => ({ emit: (...a: unknown[]) => toEmit.push(a) }),
    };
    const payload = {
      sessionId: "s1",
      messageId: null,
      pendingIds: ["p1"],
      error: "boom",
    };
    gw.onRunError(payload);
    expect(toEmit[0]).toEqual([SESSION_WS_EVENTS.runError, payload]);
  });

  it("onRunUsage：把事件转发到对应房间", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    const toEmit: unknown[] = [];
    (gw as unknown as { server: unknown }).server = {
      to: () => ({ emit: (...a: unknown[]) => toEmit.push(a) }),
    };
    const payload = {
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 3,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 100,
    };
    gw.onRunUsage(payload);
    expect(toEmit[0]).toEqual([SESSION_WS_EVENTS.runUsage, payload]);
  });

  describe("onRemoteShadowFrame（L3 影子渲染桥接）", () => {
    it("解包 REMOTE_SHADOW_FRAME_EVENT，按 payload.sessionId 转发到房间", () => {
      const runner = { getInflight: () => null, interrupt: jest.fn() };
      const gw = new SessionGateway({} as never, runner as never);
      const toEmit: unknown[] = [];
      const rooms: string[] = [];
      (gw as unknown as { server: unknown }).server = {
        to: (room: string) => {
          rooms.push(room);
          return { emit: (...a: unknown[]) => toEmit.push(a) };
        },
      };
      const payload = { sessionId: "s1", messageId: "m1", delta: "x" };

      gw.onRemoteShadowFrame({
        event: SESSION_WS_EVENTS.runChunk,
        payload,
      });

      expect(rooms).toEqual(["s1"]);
      expect(toEmit).toEqual([[SESSION_WS_EVENTS.runChunk, payload]]);
    });

    it("payload 缺 sessionId → 不转发（无房间可路由）", () => {
      const runner = { getInflight: () => null, interrupt: jest.fn() };
      const gw = new SessionGateway({} as never, runner as never);
      const toEmit: unknown[] = [];
      (gw as unknown as { server: unknown }).server = {
        to: () => ({ emit: (...a: unknown[]) => toEmit.push(a) }),
      };

      gw.onRemoteShadowFrame({
        event: SESSION_WS_EVENTS.runChunk,
        payload: { messageId: "m1", delta: "x" },
      });

      expect(toEmit).toHaveLength(0);
    });
  });
});
