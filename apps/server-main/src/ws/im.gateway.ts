import {
  BaseWebSocketGateway,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  ConversationService,
  PresenceService,
  MessageService,
  UserService,
} from "@meshbot/main";
import {
  IM_WS_EVENTS,
  IM_WS_NAMESPACE,
  type ConversationSummary,
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
} from "@nestjs/websockets";
import type { Socket } from "socket.io";

/**
 * IM WebSocket Gateway —— Phase 2 B6。
 *
 * 端点：`ws://<host>/ws/im`
 *
 * 职责：
 * - 连接时鉴权 → 入 org + conv 房间 + presence 上线 + 快照下发
 * - 断连时 presence 下线 + 广播
 * - im.send：可见性校验 → 持久化 → 房间广播
 * - im.read：标记已读
 * - im.ping：续期 presence TTL（server-agent 每 ~20s 发一次）
 * - im.conversation_created 事件（EventEmitter2）：转发到相关用户 socket
 *
 * 鉴权：handshake auth.token / query.token，由 BaseWebSocketGateway 中间件验证。
 * 未鉴权连接在宽限期（10s）内无消息即主动断开。
 *
 * ---
 * **B7 Controller 约定**：建频道/DM 成功后必须通过 EventEmitter2 发出事件：
 * ```ts
 * eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
 *   summary: ConversationSummary,
 *   userIds: string[],  // 应收到通知的用户 id 列表
 *   orgId: string,      // 用于缩小 fetchSockets 范围
 * });
 * ```
 */
@WebSocketGateway({ namespace: IM_WS_NAMESPACE, cors: true })
@UseFilters(WsExceptionFilter)
export class ImGateway extends BaseWebSocketGateway {
  constructor(
    private readonly jwt: JwtService,
    private readonly conversation: ConversationService,
    private readonly message: MessageService,
    private readonly presence: PresenceService,
    private readonly userService: UserService,
  ) {
    super();
  }

  protected jwtVerify(token: string): unknown {
    return this.jwt.verify(token);
  }

  /**
   * 连接建立：先走基类宽限计时器，再异步入房间 + presence 上线。
   * 若 jwt middleware 已验证（`client.data.user` 存在），立即执行 onAuthedConnect。
   */
  handleConnection(client: Socket): void {
    super.handleConnection(client);
    if (client.data?.user) {
      // 异步，不阻塞握手响应
      void this.onAuthedConnect(client);
    }
  }

  /**
   * 已鉴权连接后置逻辑：
   * 1. 查 activeOrgId → 无 org 直接返回
   * 2. 写 presence 在线
   * 3. 入 org 房间 + 全部可见 conv 房间
   * 4. 广播本用户上线给同 org
   * 5. 向本连接下发当前在线快照
   */
  private async onAuthedConnect(client: Socket): Promise<void> {
    const userId: string = client.data.user.userId;
    const user = await this.userService.findById(userId);
    const orgId = user?.activeOrgId;
    if (!orgId) return;

    client.data.orgId = orgId;

    await this.presence.setOnline(orgId, userId);

    client.join(`org:${orgId}`);

    const convs = await this.conversation.listConversations(userId, orgId);
    for (const conv of convs) {
      client.join(`conv:${conv.id}`);
    }

    // 广播本用户上线到同 org 所有连接（含自身）
    this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, {
      userId,
      online: true,
    } satisfies PresenceState);

    // 向本连接下发当前在线用户快照
    const onlineUserIds = await this.presence.listOnline(orgId);
    for (const onlineUserId of onlineUserIds) {
      client.emit(IM_WS_EVENTS.presence, {
        userId: onlineUserId,
        online: true,
      } satisfies PresenceState);
    }
  }

  /**
   * 断连：presence 下线 + 广播给同 org。
   * 仅在已完成鉴权 + 入 org 时执行（否则无 orgId）。
   */
  async handleDisconnect(client: Socket): Promise<void> {
    const userId: string | undefined = client.data?.user?.userId;
    const orgId: string | undefined = client.data?.orgId;
    if (!userId || !orgId) return;

    await this.presence.setOffline(orgId, userId);
    this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, {
      userId,
      online: false,
    } satisfies PresenceState);
  }

  /**
   * 发消息：校验可见性 → 持久化 → 推到 conv 房间。
   * WsExceptionFilter 统一处理 AppError（CONVERSATION_NOT_FOUND / FORBIDDEN）。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.send)
  async handleSend(
    @MessageBody() body: ImSendInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const userId: string = client.data.user.userId;
    const orgId: string = client.data.orgId;

    await this.conversation.getVisibleOrThrow(
      body.conversationId,
      userId,
      orgId,
    );

    const msg = await this.message.persistMessage(
      body.conversationId,
      userId,
      body.content,
    );

    this.server
      .to(`conv:${body.conversationId}`)
      .emit(IM_WS_EVENTS.message, msg);
  }

  /**
   * 标记已读：单表 upsert，无需返回值。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.read)
  async handleRead(
    @MessageBody() body: ImReadInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    await this.conversation.markRead(
      body.conversationId,
      client.data.user.userId,
    );
  }

  /**
   * Keepalive ping：续期 presence TTL。
   * server-agent 每 ~20s 发一次，防止 TTL（45s）到期被判离线。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage("im.ping")
  async handlePing(@ConnectedSocket() client: Socket): Promise<void> {
    const orgId: string | undefined = client.data?.orgId;
    if (orgId) {
      await this.presence.heartbeat(orgId, client.data.user.userId);
    }
  }

  /**
   * 新会话建立事件（EventEmitter2）。
   *
   * ImController (B7) 建频道 / DM 后 emit：
   * ```ts
   * eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
   *   summary, userIds, orgId,
   * });
   * ```
   *
   * 本 handler：
   * 1. fetchSockets 获取 org 房间内所有连接
   * 2. 过滤 userId 在 payload.userIds 中的连接
   * 3. 这些连接 join conv 房间 + emit conversationCreated 事件
   */
  @OnEvent(IM_WS_EVENTS.conversationCreated)
  async onConversationCreated(payload: {
    summary: ConversationSummary;
    userIds: string[];
    orgId: string;
  }): Promise<void> {
    const { summary, userIds, orgId } = payload;
    const sockets = await this.server.in(`org:${orgId}`).fetchSockets();
    for (const s of sockets) {
      if (userIds.includes(s.data.user?.userId)) {
        s.join(`conv:${summary.id}`);
        s.emit(IM_WS_EVENTS.conversationCreated, summary);
      }
    }
  }
}
