import { AppError } from "@meshbot/common";
import {
  AddChannelMemberDto,
  ConversationService,
  CreateChannelDto,
  CreateDmDto,
  DevicePresenceService,
  DeviceService,
  MainErrorCode,
  MembershipService,
  MessageService,
} from "@meshbot/main";
import {
  IM_WS_EVENTS,
  type ChannelMember,
  type ConversationSummary,
  type MessagePage,
} from "@meshbot/types";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

/**
 * IM REST 端点 —— Phase 2 B7。
 *
 * 路由（均需登录，全局 JwtAuthGuard）。注意 main.ts 已 setGlobalPrefix("api")，
 * 故此处 @Controller() 必须留空，否则路由会变成双前缀 /api/api/*：
 * - GET  /api/conversations          列出当前用户在活跃组织内的会话
 * - POST /api/channels               创建公开频道，并通知所有组织成员
 * - POST /api/dms                    创建或获取与指定用户的私信
 * - GET  /api/conversations/:id/messages 分页历史消息（游标分页）
 * - GET  /api/devices/:id/online     查设备 Agent 在线态
 *
 * Controller 只做路由接入 + 编排，业务逻辑委派给各 Service。
 */
@Controller()
export class ImController {
  constructor(
    private readonly conversation: ConversationService,
    private readonly message: MessageService,
    private readonly membership: MembershipService,
    private readonly eventEmitter: EventEmitter2,
    private readonly devicePresence: DevicePresenceService,
    private readonly devices: DeviceService,
  ) {}

  /** 列出当前用户在活跃组织内可见的会话（频道 + 私信）。 */
  @Get("conversations")
  async listConversations(
    @CurrentUser() user: JwtMainPayload,
  ): Promise<ConversationSummary[]> {
    const orgId = this.requireOrg(user);
    return this.conversation.listConversations(user.userId, orgId);
  }

  /** 创建频道；公开频道通知所有组织成员，私有频道仅通知创建者与初始成员。 */
  @Post("channels")
  async createChannel(
    @CurrentUser() user: JwtMainPayload,
    @Body() dto: CreateChannelDto,
  ): Promise<ConversationSummary> {
    const orgId = this.requireOrg(user);
    const summary = await this.conversation.persistChannelInTx(
      orgId,
      dto.name,
      user.userId,
      dto.visibility,
      dto.memberIds ?? [],
    );
    const notifyUserIds =
      dto.visibility === "private"
        ? [...new Set([user.userId, ...(dto.memberIds ?? [])])]
        : (await this.membership.listMembers(orgId)).map((m) => m.userId);
    this.eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
      summary,
      userIds: notifyUserIds,
      orgId,
    });
    return summary;
  }

  /**
   * 创建或获取与指定用户的私信（幂等）。
   * 校验目标用户是本组织成员；非成员抛 DM_TARGET_INVALID。
   * 建成/找到后向两端用户推送 conversationCreated 事件。
   */
  @Post("dms")
  async createDm(
    @CurrentUser() user: JwtMainPayload,
    @Body() dto: CreateDmDto,
  ): Promise<ConversationSummary> {
    const orgId = this.requireOrg(user);
    const targetIsMember = await this.membership.isMember(orgId, dto.userId);
    if (!targetIsMember) {
      throw new AppError(MainErrorCode.DM_TARGET_INVALID);
    }
    const summary = await this.conversation.findOrCreateDm(
      orgId,
      user.userId,
      dto.userId,
    );
    this.eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
      summary,
      userIds: [user.userId, dto.userId],
      orgId,
    });
    return summary;
  }

  /**
   * 查设备 Agent 在线态（侧栏在线点首屏用，实时更新靠 presence 事件）。
   * 用【目标设备自身的 org】查在线态（presence 按设备连接时的 device.orgId 存），
   * 而非发起方的 org —— 否则两台设备 org 不同时会双向查错。
   * 同时校验目标设备属当前账号，避免跨账号探测他人设备在线态。
   */
  @Get("devices/:id/online")
  async deviceOnline(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") id: string,
  ): Promise<{ online: boolean }> {
    const target = await this.devices.findById(id);
    if (!target || target.userId !== user.userId || !target.orgId) {
      return { online: false };
    }
    return { online: await this.devicePresence.isOnline(target.orgId, id) };
  }

  /**
   * 游标分页历史消息。
   * 先校验可见性（不可见抛 CONVERSATION_NOT_FOUND / CONVERSATION_FORBIDDEN），
   * 再按 before / limit 查询。limit 默认 30，上限 100。
   */
  @Get("conversations/:id/messages")
  async listMessages(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") id: string,
    @Query("before") before?: string,
    @Query("limit") limitStr?: string,
  ): Promise<MessagePage> {
    const orgId = this.requireOrg(user);
    await this.conversation.getVisibleOrThrow(id, user.userId, orgId);
    const n = Number(limitStr);
    const limit = Math.max(
      1,
      Math.min(Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT, MAX_LIMIT),
    );
    return this.message.listMessages(id, before, limit);
  }

  /** 拉人：把组织成员加入私有频道。 */
  @Post("channels/:id/members")
  async addMember(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") id: string,
    @Body() dto: AddChannelMemberDto,
  ): Promise<ConversationSummary> {
    const { summary, orgId } = await this.conversation.addMember(
      id,
      user.userId,
      dto.userId,
    );
    this.eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
      summary,
      userIds: [dto.userId],
      orgId,
    });
    return summary;
  }

  /** 退出私有频道（自身）。 */
  @Delete("channels/:id/members/me")
  async leave(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") id: string,
  ): Promise<{ ok: true }> {
    const { orgId } = await this.conversation.leave(id, user.userId);
    this.eventEmitter.emit(IM_WS_EVENTS.conversationRemoved, {
      conversationId: id,
      userId: user.userId,
      orgId,
    });
    return { ok: true };
  }

  /** 频道成员列表。 */
  @Get("channels/:id/members")
  async listMembers(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") id: string,
  ): Promise<ChannelMember[]> {
    const orgId = this.requireOrg(user);
    return this.conversation.listMembers(id, user.userId, orgId);
  }

  /** 取当前请求的活跃组织（token 签发时已验成员）；未选组织抛 ORG_NOT_FOUND。 */
  private requireOrg(user: JwtMainPayload): string {
    if (!user.orgId) {
      throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    }
    return user.orgId;
  }
}
