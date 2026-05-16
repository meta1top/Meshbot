import {
  BaseWebSocketGateway,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import { UseFilters, UseGuards } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Socket } from "socket.io";

/**
 * server-main WebSocket health gateway —— Phase 6 D3。
 *
 * 端点：`ws://<host>/ws/health`
 *
 * 用途：
 * - 验证 WS 框架接线（鉴权 + 异常 + traceId 透传）
 * - 给前端 / oncall 一个轻量 keepalive 通道，未来可叠加 server push
 *
 * 鉴权：
 * - handshake 中带 `auth.token` 或 `query.token`，`BaseWebSocketGateway` 经
 *   `createWsJwtMiddleware(this.jwtVerify)` 在握手时尝试 verify
 * - `WsAuthGuard` 在订阅 `ping` 时校验 `client.data.user`，缺失抛
 *   `AppError(UNAUTHORIZED)` → 客户端收 envelope + 主动 disconnect
 *
 * 链路：traceId 由 `wsTraceMiddleware` 透传上游 `x-trace-id`，在响应一并回填。
 */
@WebSocketGateway({ namespace: "ws/health", cors: true })
@UseFilters(WsExceptionFilter)
export class HealthGateway extends BaseWebSocketGateway {
  constructor(private readonly jwt: JwtService) {
    super();
  }

  protected jwtVerify(token: string): unknown {
    return this.jwt.verify(token);
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage("ping")
  handlePing(@ConnectedSocket() client: Socket): {
    pong: true;
    traceId: string;
  } {
    return { pong: true, traceId: client.data.traceId };
  }
}
