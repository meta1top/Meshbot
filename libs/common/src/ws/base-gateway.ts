import { WebSocketServer } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";

import { createWsJwtMiddleware, type WsJwtVerify } from "./ws-jwt.middleware";
import { wsTraceMiddleware } from "./ws-trace.middleware";

/**
 * 未鉴权连接的回收宽限期（毫秒）。
 *
 * jwt middleware 故意不阻断 connect（见 `createWsJwtMiddleware`），鉴权推迟到
 * `WsAuthGuard`。若客户端连上后不发任何消息，guard 永不触发、连接永不回收，
 * 形成 DoS 面。这里给未鉴权连接一个宽限窗口，到期仍无 `socket.data.user`
 * 即主动断开。
 */
const UNAUTHENTICATED_GRACE_MS = 10_000;

/**
 * BaseWebSocketGateway —— Phase 6 D2 可选辅助基类。
 *
 * 业务 gateway 继承本类即可获得：
 * - `socket.data.traceId`（`wsTraceMiddleware`）
 * - `socket.data.user`（`createWsJwtMiddleware(this.jwtVerify)`）
 * - 未鉴权连接握手期超时回收（`handleConnection`，防 DoS）
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
 * 若业务 gateway 覆写 `handleConnection`，记得 `super.handleConnection(client)`
 * 以保留未鉴权回收逻辑。
 */
export abstract class BaseWebSocketGateway {
  @WebSocketServer() protected readonly server!: Server;

  protected abstract jwtVerify(token: string): unknown;

  afterInit(server: Server): void {
    server.use(wsTraceMiddleware);
    server.use(createWsJwtMiddleware(this.jwtVerify.bind(this)));
  }

  /**
   * 连接建立时：若 jwt middleware 未能 verify（`socket.data.user` 缺失），
   * 启动宽限定时器，到期仍未鉴权则断开，防止未鉴权连接无限占用资源。
   * 鉴权成功的连接 `disconnect` 事件会清掉该定时器。
   */
  handleConnection(client: Socket): void {
    if (client.data?.user) return;
    const timer = setTimeout(() => {
      if (!client.data?.user) {
        client.disconnect(true);
      }
    }, UNAUTHENTICATED_GRACE_MS);
    // 不阻止进程退出
    timer.unref?.();
    client.once("disconnect", () => clearTimeout(timer));
  }
}
