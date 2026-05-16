import type { Socket } from "socket.io";

export type WsJwtVerify = (token: string) => unknown;

/**
 * 工厂：Socket.io 握手期 JWT verify middleware —— Phase 6 D2。
 *
 * 设计要点：
 * - **不阻断 connect**：handshake 时 token 不存在 / 不合法时也调 `next()`，
 *   让 `WsAuthGuard` 在订阅消息时拒绝并通过 `WsExceptionFilter` 给前端
 *   一个可见的 envelope。直接 `next(err)` 在 socket.io 上等同 connect_error，
 *   客户端可能只看到 "Connection refused" 类的模糊提示。
 * - **业务方提供 verify 回调**：避免 lib 与具体 jwt 库强绑定（业务可能用
 *   `@nestjs/jwt`、`jose`、`jsonwebtoken`）。
 *
 * 用法：
 * ```ts
 * server.use(createWsJwtMiddleware((token) => this.jwt.verify(token)));
 * ```
 */
export function createWsJwtMiddleware(
  jwtVerify: WsJwtVerify,
): (socket: Socket, next: (err?: Error) => void) => void {
  return (socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const query = socket.handshake.query as { token?: unknown } | undefined;
    const token =
      typeof auth?.token === "string"
        ? auth.token
        : typeof query?.token === "string"
          ? query.token
          : undefined;
    if (!token) {
      next();
      return;
    }
    try {
      const payload = jwtVerify(token);
      socket.data.user = payload;
    } catch {
      // token 不合法：不阻断连接，让 WsAuthGuard 在订阅消息时报错
    }
    next();
  };
}
