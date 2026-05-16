import { WebSocketServer } from "@nestjs/websockets";
import type { Server } from "socket.io";

import { createWsJwtMiddleware, type WsJwtVerify } from "./ws-jwt.middleware";
import { wsTraceMiddleware } from "./ws-trace.middleware";

/**
 * BaseWebSocketGateway —— Phase 6 D2 可选辅助基类。
 *
 * 业务 gateway 继承本类即可获得：
 * - `socket.data.traceId`（`wsTraceMiddleware`）
 * - `socket.data.user`（`createWsJwtMiddleware(this.jwtVerify)`）
 *
 * 业务方实现 `jwtVerify` 即可，避免与具体 jwt 库（jsonwebtoken / @nestjs/jwt / jose）绑定。
 *
 * ```ts
 * @WebSocketGateway({ namespace: "ws/health" })
 * export class HealthGateway extends BaseWebSocketGateway {
 *   constructor(private readonly jwt: JwtService) { super(); }
 *   jwtVerify(token: string) { return this.jwt.verify(token); }
 * }
 * ```
 *
 * 不想用本基类的业务方可以在自己的 `afterInit` 里直接 `server.use(...)`。
 */
export abstract class BaseWebSocketGateway {
  @WebSocketServer() protected readonly server!: Server;

  protected abstract jwtVerify(token: string): unknown;

  afterInit(server: Server): void {
    server.use(wsTraceMiddleware);
    server.use(createWsJwtMiddleware(this.jwtVerify.bind(this)));
  }
}
