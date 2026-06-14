import {
  BaseWebSocketGateway,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  IM_WS_EVENTS,
  IM_WS_NAMESPACE,
  type ConversationSummary,
  type ImMessage,
  type ImReadInput,
  type ImSendInput,
  type PresenceState,
} from "@meshbot/types";
import { UseFilters, UseGuards } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { ImRelayClientService } from "../cloud/im-relay-client.service";

/**
 * 本地 IM WebSocket Gateway。端点：ws://<host>/ws/im
 *
 * - 复用 BaseWebSocketGateway 的握手鉴权 + 未鉴权宽限回收
 * - 下行（云端 → 本地浏览器）：监听 ImRelayClientService 经 EventEmitter2
 *   转发的 im.* 事件，向本 namespace 所有已连接客户端广播（本地单用户，
 *   无需 room 路由；浏览器按 conversationId 自行过滤）
 * - 上行（本地浏览器 → 云端）：im.send / im.read 由浏览器触发，
 *   转交 ImRelayClientService 经云端 socket 上行；未连接时 send 抛
 *   IM_NOT_CONNECTED，由 WsExceptionFilter 统一处理
 */
@WebSocketGateway({ namespace: IM_WS_NAMESPACE, cors: true })
@UseFilters(WsExceptionFilter)
export class ImGateway extends BaseWebSocketGateway {
  constructor(
    private readonly jwt: JwtService,
    private readonly imRelay: ImRelayClientService,
  ) {
    super();
  }

  protected jwtVerify(token: string): unknown {
    return this.jwt.verify(token);
  }

  /**
   * 云端下行：新 IM 消息 → namespace 广播给所有本地浏览器 socket。
   *
   * ImRelayClientService 收到云端 `im.message` 后经 EventEmitter2 触发此方法。
   */
  @OnEvent(IM_WS_EVENTS.message)
  onMessage(payload: ImMessage): void {
    this.server.emit(IM_WS_EVENTS.message, payload);
  }

  /**
   * 云端下行：用户在线状态变更 → namespace 广播。
   *
   * ImRelayClientService 收到云端 `im.presence` 后经 EventEmitter2 触发此方法。
   */
  @OnEvent(IM_WS_EVENTS.presence)
  onPresence(payload: PresenceState): void {
    this.server.emit(IM_WS_EVENTS.presence, payload);
  }

  /**
   * 云端下行：新会话创建通知 → namespace 广播。
   *
   * ImRelayClientService 收到云端 `im.conversation_created` 后经 EventEmitter2
   * 触发此方法，浏览器刷新会话列表。
   */
  @OnEvent(IM_WS_EVENTS.conversationCreated)
  onConversationCreated(payload: ConversationSummary): void {
    this.server.emit(IM_WS_EVENTS.conversationCreated, payload);
  }

  /**
   * 上行：浏览器发送 IM 消息 → 转交 ImRelayClientService 经云端 socket 上行。
   *
   * 未连接时 ImRelayClientService.send 抛 AppError(IM_NOT_CONNECTED)，
   * WsExceptionFilter 统一转为 WsException 回传客户端。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.send)
  handleSend(@MessageBody() body: ImSendInput): void {
    this.imRelay.send(body);
  }

  /**
   * 上行：浏览器标记消息已读 → 转交 ImRelayClientService 经云端 socket 上行。
   *
   * best-effort：ImRelayClientService.read 未连接时静默跳过，无需处理异常。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.read)
  handleRead(@MessageBody() body: ImReadInput): void {
    this.imRelay.read(body);
  }
}
