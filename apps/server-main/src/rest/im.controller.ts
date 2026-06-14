import { AppError } from "@meshbot/common";
import {
  ConversationService,
  CreateChannelDto,
  CreateDmDto,
  MainErrorCode,
  MembershipService,
  MessageService,
  UserService,
} from "@meshbot/main";
import {
  IM_WS_EVENTS,
  type ConversationSummary,
  type MessagePage,
} from "@meshbot/types";
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

/**
 * IM REST 端点 —— Phase 2 B7。
 *
 * 路由（均需登录，全局 JwtAuthGuard）：
 * - GET  /api/conversations          列出当前用户在活跃组织内的会话
 * - POST /api/channels               创建公开频道，并通知所有组织成员
 * - POST /api/dms                    创建或获取与指定用户的私信
 * - GET  /api/conversations/:id/messages 分页历史消息（游标分页）
 *
 * Controller 只做路由接入 + 编排，业务逻辑委派给各 Service。
 */
@Controller("api")
export class ImController {
  constructor(
    private readonly conversation: ConversationService,
    private readonly message: MessageService,
    private readonly membership: MembershipService,
    private readonly users: UserService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** 列出当前用户在活跃组织内可见的会话（频道 + 私信）。 */
  @Get("conversations")
  async listConversations(
    @CurrentUser() user: JwtMainPayload,
  ): Promise<ConversationSummary[]> {
    const orgId = await this.resolveOrgId(user.userId);
    return this.conversation.listConversations(user.userId, orgId);
  }

  /** 创建公开频道；建成后向所有组织成员推送 conversationCreated 事件。 */
  @Post("channels")
  async createChannel(
    @CurrentUser() user: JwtMainPayload,
    @Body() dto: CreateChannelDto,
  ): Promise<ConversationSummary> {
    const orgId = await this.resolveOrgId(user.userId);
    const summary = await this.conversation.persistChannelInTx(
      orgId,
      dto.name,
      user.userId,
    );
    const members = await this.membership.listMembers(orgId);
    this.eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
      summary,
      userIds: members.map((m) => m.userId),
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
    const orgId = await this.resolveOrgId(user.userId);
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
    const orgId = await this.resolveOrgId(user.userId);
    await this.conversation.getVisibleOrThrow(id, user.userId, orgId);
    const limit = limitStr
      ? Math.min(Number(limitStr) || DEFAULT_LIMIT, MAX_LIMIT)
      : DEFAULT_LIMIT;
    return this.message.listMessages(id, before, limit);
  }

  /** 解析当前用户的活跃组织 ID；未设置活跃组织则抛 ORG_NOT_FOUND。 */
  private async resolveOrgId(userId: string): Promise<string> {
    const user = await this.users.findById(userId);
    if (!user?.activeOrgId) {
      throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    }
    return user.activeOrgId;
  }
}
