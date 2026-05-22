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
  it("subscribe：join 房间，有 inflight 则回推快照", () => {
    const runner = {
      getInflight: () => ({
        messageId: "m1",
        content: "部分",
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
      SESSION_WS_EVENTS.runChunk,
      { sessionId: "s1", messageId: "m1", delta: "部分" },
    ]);
  });

  it("subscribe：inflight messageId 为 null 时回推空字符串", () => {
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
    expect(sock.emitted[0]).toEqual([
      SESSION_WS_EVENTS.runChunk,
      { sessionId: "s1", messageId: "", delta: "部分内容" },
    ]);
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
});
