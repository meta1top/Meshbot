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
   *
   * 到期回调必须先确认 `client.disconnect` 仍可调用：服务端强制关闭
   * socket.io server 时（典型场景是 e2e 的 `app.close()`），socket 可能不派发
   * `disconnect` 事件就被拆解，下面 `once` 注册的清理路径随之失效，定时器
   * 存活到到期——此时 client 已不是可用 socket，直接调用会抛
   * `client.disconnect is not a function`。该异常逃逸到 jest worker 后会被
   * 归咎于「当时正在跑的那个套件」，表现为失败套件在多次运行间漂移
   * （实测 auth-profile.e2e ↔ skill-flow），极难定位。
   *
   * `timer.unref()` 只保证不阻止进程退出，不阻止定时器触发——jest 进程在跑
   * 后续套件时依然活着，10 秒的宽限期足够横跨好几个套件。
   */
  handleConnection(client: Socket): void {
    if (client.data?.user) return;
    const timer = setTimeout(() => {
      if (client.data?.user) return;
      if (typeof client.disconnect !== "function") return;
      client.disconnect(true);
    }, UNAUTHENTICATED_GRACE_MS);
    // 不阻止进程退出
    timer.unref?.();
    client.once("disconnect", () => clearTimeout(timer));
  }
}
