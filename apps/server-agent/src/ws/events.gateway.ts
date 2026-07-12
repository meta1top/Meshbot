import {
  AppError,
  BaseWebSocketGateway,
  CommonErrorCode,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  AUTH_WS_EVENTS,
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
import {
  QUICK_ASSISTANT_EVENTS,
  type QuickAssistantRenamedEvent,
  MODEL_CONFIG_EVENTS,
  type ModelConfigUpdatedEvent,
  SCHEDULE_EVENTS,
  type ScheduleFiredEvent,
} from "@meshbot/types-agent";
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
import { AccountContextService } from "@meshbot/lib-agent";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import { AUTH_EVENTS } from "../services/auth.events";

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
  /** 每账号当前浏览器（ws/events）连接数；0↔1 跳变时驱动 relay 上报在线/离线。 */
  private readonly browserCounts = new Map<string, number>();

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
      // 回放当前已知在线快照给这个新浏览器——修「浏览器晚于 relay 连接、错过 server-main
      // 初始在线快照」导致早已在线的对端一直显示离线（presenceAtom 初值为空=灰）。
      for (const userId of this.imRelay.getOnlinePeers(sub)) {
        const env: GlobalEventEnvelope = {
          type: IM_WS_EVENTS.presence,
          payload: { userId, online: true } satisfies PresenceState,
          ts: Date.now(),
        };
        client.emit("event", env);
      }
      // 在线状态：浏览器连接数 0→1 → 该账号上线
      const n = (this.browserCounts.get(sub) ?? 0) + 1;
      this.browserCounts.set(sub, n);
      if (n === 1) {
        this.imRelay.setUiPresence(sub, true);
      }
    }
  }

  /**
   * 浏览器断开：连接数 1→0 → 该账号离线（关最后一个窗口即离线）。
   * 多窗口时仅减计数、保持在线。
   */
  handleDisconnect(client: Socket): void {
    const sub = (client.data?.user as { sub?: unknown } | undefined)?.sub;
    if (typeof sub !== "string") return;
    const n = (this.browserCounts.get(sub) ?? 0) - 1;
    if (n <= 0) {
      this.browserCounts.delete(sub);
      this.imRelay.setUiPresence(sub, false);
    } else {
      this.browserCounts.set(sub, n);
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
   * 本地定时任务触发 → 信封投递给所属账号浏览器。
   *
   * ScheduleExecutor.fire 触发后经 EventEmitter2 触发此方法，
   * 浏览器可据此刷新任务状态或显示触发通知。
   */
  @OnEvent(SCHEDULE_EVENTS.fired)
  onScheduleFired(payload: ScheduleFiredEvent): void {
    this.emitEnvelope(SCHEDULE_EVENTS.fired, payload);
  }

  /**
   * 本地随手问改名 → 信封投递给所属账号浏览器，dock 标题实时刷新。
   *
   * QuickAssistantService.setName（agent 改名 tool / UI 改名）经 EventEmitter2 触发，
   * 在账号上下文内 emit，故 emitEnvelope 能取到账号路由到 acct 房间。
   */
  @OnEvent(QUICK_ASSISTANT_EVENTS.renamed)
  onQuickAssistantRenamed(payload: QuickAssistantRenamedEvent): void {
    this.emitEnvelope(QUICK_ASSISTANT_EVENTS.renamed, payload);
  }

  /**
   * 云端模型配置同步完成 → 信封投递给所属账号浏览器，模型列表实时刷新。
   *
   * ModelConfigSyncService.syncNow 成功后经 EventEmitter2 触发（事件驱动同步：
   * 云端推送 / relay 重连 / 登录），前端收到后 invalidate model-configs 查询。
   */
  @OnEvent(MODEL_CONFIG_EVENTS.updated)
  onModelConfigUpdated(payload: ModelConfigUpdatedEvent): void {
    this.emitEnvelope(MODEL_CONFIG_EVENTS.updated, payload);
  }

  /**
   * 本地：云端凭据吊销/401（relay connect_error unauthorized 或 CloudClient 401
   * unauthorizedHandler）→ 信封投递给所属账号浏览器，提示重新授权登录。
   *
   * 发射方（ImRelayClientService / auth.module CloudClientService 工厂）已用
   * `account.run(cloudUserId, ...)` 包裹 emit，故此处 emitEnvelope 能取到账号路由。
   */
  @OnEvent(AUTH_EVENTS.reauthRequired)
  onReauthRequired(payload: { cloudUserId: string }): void {
    this.emitEnvelope(AUTH_WS_EVENTS.reauthRequired, payload);
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
