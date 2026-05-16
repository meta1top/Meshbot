import "reflect-metadata";

import type { Socket } from "socket.io";

import { wsTraceMiddleware } from "./ws-trace.middleware";

function makeSocket(opts: {
  headers?: Record<string, string>;
  auth?: Record<string, unknown>;
}): Socket {
  return {
    data: {},
    handshake: {
      headers: opts.headers ?? {},
      auth: opts.auth ?? {},
    },
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩，只用 data/handshake
  } as any;
}

describe("wsTraceMiddleware", () => {
  it("透传上游 x-trace-id header", () => {
    const socket = makeSocket({ headers: { "x-trace-id": "trace-123" } });
    const next = jest.fn();
    wsTraceMiddleware(socket, next);
    expect(socket.data.traceId).toBe("trace-123");
    expect(next).toHaveBeenCalledWith();
  });

  it("auth.traceId 作为 fallback", () => {
    const socket = makeSocket({ auth: { traceId: "auth-trace" } });
    const next = jest.fn();
    wsTraceMiddleware(socket, next);
    expect(socket.data.traceId).toBe("auth-trace");
  });

  it("header 优先于 auth", () => {
    const socket = makeSocket({
      headers: { "x-trace-id": "from-header" },
      auth: { traceId: "from-auth" },
    });
    const next = jest.fn();
    wsTraceMiddleware(socket, next);
    expect(socket.data.traceId).toBe("from-header");
  });

  it("缺失时生成 UUID", () => {
    const socket = makeSocket({});
    const next = jest.fn();
    wsTraceMiddleware(socket, next);
    expect(socket.data.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("空字符串 x-trace-id 视为缺失，生成 UUID", () => {
    const socket = makeSocket({ headers: { "x-trace-id": "" } });
    const next = jest.fn();
    wsTraceMiddleware(socket, next);
    expect(socket.data.traceId).not.toBe("");
    expect(socket.data.traceId).toHaveLength(36);
  });
});
