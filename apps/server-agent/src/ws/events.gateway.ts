import {
  AppError,
  BaseWebSocketGateway,
  CommonErrorCode,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  EVENTS_WS_NAMESPACE,
  IM_WS_EVENTS,
  type ConversationSummary,
  type GlobalEventEnvelope,
  type ImConversationReadEvent,
  type ImMessage,
  type ImReadInput,
  type ImSendInput,
  type PresenceState,
} from "@meshbot/types";
import { UseFilters, UseGuards } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { AccountContextService } from "@meshbot/agent";
import { ImRelayClientService } from "../cloud/im-relay-client.service";

/**
 * 本地事件总线 WebSocket Gateway。端点：ws://<host>/ws/events
 *
 * - 复用 BaseWebSocketGateway 的握手鉴权 + 未鉴权宽限回收
 * - 下行（云端 → 本地浏览器）：统一信封 `{type, payload, ts}` 以单一 `event` 名
 *   按账号路由到 `acct:<cloudUserId>` 房间——多账号同时在线时每个事件只投递给
 *   所属账号的浏览器，避免重复投递与跨账号泄漏
 * - 上行（本地浏览器 → 云端）：im.send / im.read 由浏览器触发，
 *   转交 ImRelayClientService 经云端 socket 上行；未连接时 send 抛
 *   IM_NOT_CONNECTED，由 WsExceptionFilter 统一处理
 */
@WebSocketGateway({ namespace: EVENTS_WS_NAMESPACE, cors: true })
@UseFilters(WsExceptionFilter)
export class EventsGateway extends BaseWebSocketGateway {
  constructor(
    private readonly jwt: JwtService,
    private readonly imRelay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {
    super();
  }

  protected jwtVerify(token: string): unknown {
    return this.jwt.verify(token);
  }

  /**
   * 浏览器连接：保留基类未鉴权回收，并把已鉴权 socket 按账号加入 `acct:<sub>` 房间。
   * 下行事件据此只投递给所属账号的浏览器——多账号同时在线时（如本地登录多账号、
   * 或开发期多窗口）避免同一事件经各账号 relay 重复广播、以及跨账号泄漏。
   */
  handleConnection(client: Socket): void {
    super.handleConnection(client);
    const sub = (client.data?.user as { sub?: unknown } | undefined)?.sub;
    if (typeof sub === "string") {
      client.join(`acct:${sub}`);
    }
  }

  /**
   * 云端下行：新 IM 消息 → 信封投递给所属账号浏览器。
   *
   * ImRelayClientService 收到云端 `im.message` 后经 EventEmitter2 触发此方法。
   */
  @OnEvent(IM_WS_EVENTS.message)
  onMessage(payload: ImMessage): void {
    this.emitEnvelope(IM_WS_EVENTS.message, payload);
  }

  /**
   * 云端下行：用户在线状态变更 → 信封投递。
   *
   * ImRelayClientService 收到云端 `im.presence` 后经 EventEmitter2 触发此方法。
   */
  @OnEvent(IM_WS_EVENTS.presence)
  onPresence(payload: PresenceState): void {
    this.emitEnvelope(IM_WS_EVENTS.presence, payload);
  }

  /**
   * 云端下行：新会话创建通知 → 信封投递。
   *
   * ImRelayClientService 收到云端 `im.conversation_created` 后经 EventEmitter2
   * 触发此方法，浏览器刷新会话列表。
   */
  @OnEvent(IM_WS_EVENTS.conversationCreated)
  onConversationCreated(payload: ConversationSummary): void {
    this.emitEnvelope(IM_WS_EVENTS.conversationCreated, payload);
  }

  /**
   * 云端下行：频道被移除通知 → 信封投递。
   *
   * ImRelayClientService 收到云端 `im.conversation_removed` 后经 EventEmitter2
   * 触发此方法，浏览器刷新会话列表。
   */
  @OnEvent(IM_WS_EVENTS.conversationRemoved)
  onConversationRemoved(payload: { conversationId: string }): void {
    this.emitEnvelope(IM_WS_EVENTS.conversationRemoved, payload);
  }

  /**
   * 云端下行：会话已读通知 → 信封投递。
   *
   * ImRelayClientService 收到云端 `im.conversation_read` 后经 EventEmitter2
   * 触发此方法，浏览器更新会话已读状态。
   */
  @OnEvent(IM_WS_EVENTS.conversationRead)
  onConversationRead(payload: ImConversationReadEvent): void {
    this.emitEnvelope(IM_WS_EVENTS.conversationRead, payload);
  }

  /**
   * 下行投递：把任意事件包成全局信封 `{type,payload,ts}`，以单一 `event` 名只发给
   * 当前下行事件所属账号的 acct 房间（relay 经 account.run 同步触发，故能取到账号）。
   * 无账号上下文（理论不应发生）→ 降级全量广播，保证不丢。
   */
  private emitEnvelope(type: string, payload: unknown): void {
    const env: GlobalEventEnvelope = { type, payload, ts: Date.now() };
    const cloudUserId = this.account.get();
    if (!cloudUserId) {
      this.server.emit("event", env);
      return;
    }
    this.server.to(`acct:${cloudUserId}`).emit("event", env);
  }

  /**
   * 上行：浏览器发送 IM 消息 → 转交 ImRelayClientService 经云端 socket 上行。
   *
   * 账号来源：握手期 JWT middleware 写入的 `client.data.user`（payload
   * `{ sub: cloudUserId, email }`），`WsAuthGuard` 已保证其存在，`sub` 即云端账号 id，
   * 用以定位该账号的云连接（v3 每账号独立连接）。
   * 未连接时 ImRelayClientService.send 抛 AppError(IM_NOT_CONNECTED)，
   * WsExceptionFilter 统一转为 WsException 回传客户端。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.send)
  handleSend(
    @MessageBody() body: ImSendInput,
    @ConnectedSocket() client: Socket,
  ): void {
    this.imRelay.send(this.cloudUserId(client), body);
  }

  /**
   * 上行：浏览器标记消息已读 → 转交 ImRelayClientService 经云端 socket 上行。
   *
   * 账号来源同 handleSend（`client.data.user.sub`）。
   * best-effort：ImRelayClientService.read 未连接时静默跳过，无需处理异常。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.read)
  handleRead(
    @MessageBody() body: ImReadInput,
    @ConnectedSocket() client: Socket,
  ): void {
    this.imRelay.read(this.cloudUserId(client), body);
  }

  /**
   * 从已鉴权 socket 解析云端账号 id（本地 JWT 的 `sub`）。
   * `WsAuthGuard` 保证 `client.data.user` 存在；缺 `sub` 视为未鉴权。
   */
  private cloudUserId(client: Socket): string {
    const user = client.data?.user as { sub?: unknown } | undefined;
    if (typeof user?.sub !== "string") {
      throw new WsException(new AppError(CommonErrorCode.UNAUTHORIZED));
    }
    return user.sub;
  }
}
