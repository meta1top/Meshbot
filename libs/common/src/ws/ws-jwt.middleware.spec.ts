import "reflect-metadata";

import type { Socket } from "socket.io";

import { createWsJwtMiddleware } from "./ws-jwt.middleware";

function makeSocket(opts: {
  auth?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): Socket {
  return {
    data: {},
    handshake: {
      headers: {},
      auth: opts.auth ?? {},
      query: opts.query ?? {},
    },
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
  } as any;
}

describe("createWsJwtMiddleware", () => {
  it("合法 token → socket.data.user 写入 payload", () => {
    const mw = createWsJwtMiddleware((t) => ({ sub: t }));
    const socket = makeSocket({ auth: { token: "abc" } });
    const next = jest.fn();
    mw(socket, next);
    expect(socket.data.user).toEqual({ sub: "abc" });
    expect(next).toHaveBeenCalledWith();
  });

  it("无 token → next() 但 user 未设", () => {
    const verify = jest.fn();
    const mw = createWsJwtMiddleware(verify);
    const socket = makeSocket({});
    const next = jest.fn();
    mw(socket, next);
    expect(verify).not.toHaveBeenCalled();
    expect(socket.data.user).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  it("verify 抛错 → 不阻断，user 未设", () => {
    const mw = createWsJwtMiddleware(() => {
      throw new Error("bad token");
    });
    const socket = makeSocket({ auth: { token: "bad" } });
    const next = jest.fn();
    mw(socket, next);
    expect(socket.data.user).toBeUndefined();
    expect(next).toHaveBeenCalledWith(); // 无参数 = 放行
  });

  it("query.token 作为 fallback", () => {
    const mw = createWsJwtMiddleware((t) => ({ from: "query", t }));
    const socket = makeSocket({ query: { token: "qtoken" } });
    const next = jest.fn();
    mw(socket, next);
    expect(socket.data.user).toEqual({ from: "query", t: "qtoken" });
  });

  it("auth 优先于 query", () => {
    const mw = createWsJwtMiddleware((t) => t);
    const socket = makeSocket({
      auth: { token: "auth-t" },
      query: { token: "query-t" },
    });
    const next = jest.fn();
    mw(socket, next);
    expect(socket.data.user).toBe("auth-t");
  });
});
