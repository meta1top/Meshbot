import {
  AppError,
  BaseWebSocketGateway,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  ConversationService,
  DEVICE_TOKEN_PREFIX,
  DeviceService,
  MainErrorCode,
  MessageService,
  PresenceService,
  UserService,
} from "@meshbot/main";
import {
  IM_WS_EVENTS,
  IM_WS_NAMESPACE,
  type ConversationSummary,
  type ImConversationReadEvent,
  type ImPresenceSetInput,
  type ImReadInput,
  type ImSendInput,
  type PresenceState,
} from "@meshbot/types";
import { Logger, UseFilters, UseGuards } from "@nestjs/common";
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
  private readonly logger = new Logger(ImGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly conversation: ConversationService,
    private readonly message: MessageService,
    private readonly presence: PresenceService,
    private readonly userService: UserService,
    private readonly devices: DeviceService,
  ) {
    super();
  }

  /**
   * 双凭据握手校验（Task 8）：
   * - `mbd_` 前缀（Agent device token）→ `DeviceService.verifyToken`（异步），
   *   payload 为 `{ userId, orgId, deviceId }`（orgId 来自 device.orgId，无 email）
   * - 其余走浏览器用户 JWT 同步 verify，行为不变
   */
  protected jwtVerify(token: string): unknown {
    if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
      return this.devices
        .verifyToken(token)
        .then((d) => ({ userId: d.userId, orgId: d.orgId, deviceId: d.id }));
    }
    return this.jwt.verify(token);
  }

  /**
   * 解析连接归属 orgId：
   * - device 连接（payload 带 deviceId）→ 直接用握手 payload 的 orgId（device.orgId），
   *   不查 activeOrgId（设备当前组织与用户浏览器活跃组织解耦）
   * - 用户 JWT 连接 → 保持现状查 `userService.findById(...).activeOrgId`
   */
  private async resolveOrgId(client: Socket): Promise<string | undefined> {
    const payload = client.data.user as {
      userId: string;
      orgId?: string | null;
      deviceId?: string;
    };
    if (payload.deviceId) return payload.orgId ?? undefined;
    const user = await this.userService.findById(payload.userId);
    return user?.activeOrgId ?? undefined;
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
   * 1. 解析 orgId（device 连接用 payload.orgId，用户 JWT 查 activeOrgId）→ 无 org 直接返回
   * 2. 入 org 房间 + 全部可见 conv 房间
   * 3. 向本连接下发当前在线快照
   *
   * 注意：relay 连接不再自动上线（presence 由 im.presence_set 事件驱动，
   * 由 server-agent EventsGateway 按浏览器连接数聚合后上报）。
   */
  private async onAuthedConnect(client: Socket): Promise<void> {
    try {
      const userId: string = client.data.user.userId;
      const orgId = await this.resolveOrgId(client);
      if (!orgId) return;

      client.data.orgId = orgId;

      client.join(`org:${orgId}`);

      const convs = await this.conversation.listConversations(userId, orgId);
      for (const conv of convs) {
        client.join(`conv:${conv.id}`);
      }

      // 向本连接下发当前在线用户快照
      const onlineUserIds = await this.presence.listOnline(orgId);
      for (const onlineUserId of onlineUserIds) {
        client.emit(IM_WS_EVENTS.presence, {
          userId: onlineUserId,
          online: true,
        } satisfies PresenceState);
      }
    } catch (err) {
      this.logger.error("im onAuthedConnect failed", err as Error);
      client.disconnect(true);
    }
  }

  /**
   * 断连：presence 下线 + 广播给同 org。
   * 仅在已完成鉴权 + 入 org 时执行（否则无 orgId）。
   */
  async handleDisconnect(client: Socket): Promise<void> {
    try {
      const userId: string | undefined = client.data?.user?.userId;
      const orgId: string | undefined = client.data?.orgId;
      if (!userId || !orgId) return;

      await this.presence.setOffline(orgId, userId);
      this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, {
        userId,
        online: false,
      } satisfies PresenceState);
    } catch (err) {
      this.logger.error("im handleDisconnect failed", err as Error);
    }
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
    const orgId: string | undefined = client.data.orgId;
    if (!orgId) throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);

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
   * 标记已读：find + save 更新 lastReadAt，返回写入时间戳。
   * 写完后向「该 userId 的全部在线连接」广播 im.conversation_read（多窗口/多端清未读）。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.read)
  async handleRead(
    @MessageBody() body: ImReadInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const orgId: string | undefined = client.data?.orgId;
    if (!orgId) return;

    const userId: string = client.data.user.userId;

    await this.conversation.getVisibleOrThrow(
      body.conversationId,
      userId,
      orgId,
    );

    const lastReadAt = await this.conversation.markRead(
      body.conversationId,
      userId,
    );

    // 广播给「该用户」的全部在线连接（多窗口/多端清未读）；按 org 房间取连接后按 userId 过滤
    const sockets = await this.server.in(`org:${orgId}`).fetchSockets();
    for (const s of sockets) {
      if (s.data.user?.userId === userId) {
        s.emit(IM_WS_EVENTS.conversationRead, {
          conversationId: body.conversationId,
          lastReadAt: lastReadAt.toISOString(),
        } satisfies ImConversationReadEvent);
      }
    }
  }

  /**
   * 浏览器在线态上报（server-agent 按浏览器连接数聚合后发）。
   * online → setOnline + 广播；offline → setOffline + 广播。
   *
   * 竞态修复：relay 一连上就立即 emit presence_set，而 onAuthedConnect 是异步的，
   * orgId 可能尚未落到 client.data。若缺失则就地从 userService 解析并回写，
   * 避免登录初次竞态导致上线事件被静默丢弃。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.presenceSet)
  async handlePresenceSet(
    @MessageBody() body: ImPresenceSetInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const userId: string = client.data.user.userId;
    let orgId: string | undefined = client.data?.orgId;
    if (!orgId) {
      // presence_set 可能早于 onAuthedConnect 落定 orgId（relay 一连上就上报）；就地解析。
      orgId = await this.resolveOrgId(client);
      if (orgId) client.data.orgId = orgId;
    }
    if (!orgId) return;
    if (body.online) {
      await this.presence.setOnline(orgId, userId);
    } else {
      await this.presence.setOffline(orgId, userId);
    }
    this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, {
      userId,
      online: body.online,
    } satisfies PresenceState);
  }

  /**
   * Keepalive ping：续期 presence TTL。
   * server-agent 每 ~20s 发一次，防止 TTL（45s）到期被判离线。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.ping)
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
    try {
      const { summary, userIds, orgId } = payload;
      const sockets = await this.server.in(`org:${orgId}`).fetchSockets();
      for (const s of sockets) {
        if (userIds.includes(s.data.user?.userId)) {
          s.join(`conv:${summary.id}`);
          s.emit(IM_WS_EVENTS.conversationCreated, summary);
        }
      }
    } catch (err) {
      this.logger.error("im onConversationCreated failed", err as Error);
    }
  }

  /** 成员退出私有频道：让其在线 socket 离开 conv 房间并下发移除通知。 */
  @OnEvent(IM_WS_EVENTS.conversationRemoved)
  async onConversationRemoved(payload: {
    conversationId: string;
    userId: string;
    orgId: string;
  }): Promise<void> {
    try {
      const { conversationId, userId, orgId } = payload;
      const sockets = await this.server.in(`org:${orgId}`).fetchSockets();
      for (const s of sockets) {
        if (s.data.user?.userId === userId) {
          s.leave(`conv:${conversationId}`);
          s.emit(IM_WS_EVENTS.conversationRemoved, { conversationId });
        }
      }
    } catch (err) {
      this.logger.error("im onConversationRemoved failed", err as Error);
    }
  }
}
