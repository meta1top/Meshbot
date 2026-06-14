import { AppError, Transactional, WithLock } from "@meshbot/common";
import type { ConversationSummary, ImPeer } from "@meshbot/types";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { Conversation } from "../entities/conversation.entity";
import { ConversationMember } from "../entities/conversation-member.entity";
import { MainErrorCode } from "../errors/main.error-codes";
import { MessageService } from "./message.service";
import { UserService } from "./user.service";

/**
 * ConversationService — Conversation + ConversationMember 的唯一归属 Service。
 *
 * 职责：
 * - 频道建立（persistChannelInTx）：跨表写，@Transactional()
 * - DM 去重（findOrCreateDm）：先排序 dmKey，再 @WithLock（按 orgId+dmKey）包 @Transactional()
 * - 默认频道保障（ensureDefaultChannel）：@WithLock（按 orgId）包单表写
 * - 可见性校验（getVisibleOrThrow）：只读，无需事务
 * - 会话列表（listConversations）：组合 MessageService + UserService
 * - 已读标记（markRead）：单表 upsert，无需事务
 *
 * 装饰器顺序：@WithLock 在 @Transactional 外层（check:lock-tx 要求）。
 */
@Injectable()
export class ConversationService {
  constructor(
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
    @InjectRepository(ConversationMember)
    private readonly memberRepo: Repository<ConversationMember>,
    private readonly messageService: MessageService,
    private readonly userService: UserService,
  ) {}

  /**
   * 列出 userId 在 orgId 内可见的会话。
   * = 该 org 全部 channel + userId 参与的 dm。
   * 先调 ensureDefaultChannel 保证至少一个频道。
   * 每项组装 ConversationSummary（name / peer / unreadCount / lastMessage）。
   */
  async listConversations(
    userId: string,
    orgId: string,
  ): Promise<ConversationSummary[]> {
    await this.ensureDefaultChannel(orgId, userId);

    // 全部频道（按 org）
    const channels = await this.convRepo.find({
      where: { orgId, type: "channel" },
    });

    // 用户参与的 DM（通过 member 表找到 conversationId）
    const dmMembers = await this.memberRepo.find({ where: { userId } });
    const dmConvIds = dmMembers.map((m) => m.conversationId);

    let dms: Conversation[] = [];
    if (dmConvIds.length > 0) {
      // 只取属于该 org 的 dm
      const allDms = await this.convRepo.find({ where: { orgId, type: "dm" } });
      dms = allDms.filter((c) => dmConvIds.includes(c.id));
    }

    const allConvs = [...channels, ...dms];

    const summaries: ConversationSummary[] = await Promise.all(
      allConvs.map((conv) => this.toSummary(conv, userId)),
    );

    return summaries;
  }

  /**
   * 建频道。跨表写（conversation + member），走 @Transactional()。
   * 命名遵循 *InTx 约定（check:naming）。
   */
  @Transactional()
  async persistChannelInTx(
    orgId: string,
    name: string,
    createdBy: string,
  ): Promise<ConversationSummary> {
    const conv = await this.convRepo.save(
      this.convRepo.create({
        orgId,
        type: "channel",
        name,
        dmKey: null,
        createdBy,
      }),
    );
    const memberRepo = this.convRepo.manager.getRepository(ConversationMember);
    await memberRepo.save(
      memberRepo.create({
        conversationId: conv.id,
        userId: createdBy,
        lastReadAt: null,
      }),
    );
    return this.toSummary(conv, createdBy);
  }

  /**
   * 查找或创建两人 DM。幂等：按 (orgId, dmKey, type='dm') 查。
   * 先对 (a, b) 排序得到 dmKey，再委托 findOrCreateDmLocked，
   * 确保无论参数顺序如何都使用同一把锁（sort-invariant）。
   * peer 相对于发起者 a（对端为 b）。
   */
  async findOrCreateDm(
    orgId: string,
    a: string,
    b: string,
  ): Promise<ConversationSummary> {
    const dmKey = [a, b].sort().join(":");
    return this.findOrCreateDmLocked(orgId, dmKey, a, b);
  }

  /**
   * @WithLock 按 (orgId, dmKey) 加锁，确保并发的正、反序调用互斥。
   * 锁在 @Transactional 外层（check:lock-tx 要求）。
   */
  @WithLock({ key: "dm:findOrCreate:#{0}:#{1}", waitTimeout: 5000 })
  private async findOrCreateDmLocked(
    orgId: string,
    dmKey: string,
    a: string,
    b: string,
  ): Promise<ConversationSummary> {
    return this.persistDmInTx(orgId, dmKey, a, b);
  }

  /**
   * DM 事务体：查已有 DM，无则建会话 + 两条 member 行。
   * @Transactional() — 跨表写，命名 *InTx（check:naming）。
   */
  @Transactional()
  private async persistDmInTx(
    orgId: string,
    dmKey: string,
    a: string,
    b: string,
  ): Promise<ConversationSummary> {
    const existing = await this.convRepo.findOne({
      where: { orgId, dmKey, type: "dm" },
    });

    if (existing) {
      return this.toSummary(existing, a);
    }

    const memberRepo = this.convRepo.manager.getRepository(ConversationMember);
    const conv = await this.convRepo.save(
      this.convRepo.create({
        orgId,
        type: "dm",
        name: null,
        dmKey,
        createdBy: a,
      }),
    );
    await memberRepo.save(
      memberRepo.create({
        conversationId: conv.id,
        userId: a,
        lastReadAt: null,
      }),
    );
    await memberRepo.save(
      memberRepo.create({
        conversationId: conv.id,
        userId: b,
        lastReadAt: null,
      }),
    );

    return this.toSummary(conv, a);
  }

  /**
   * 可见性校验：
   * - channel → conversation.orgId === orgId（调用方已保证 org 成员）
   * - dm      → 必须有 conversation_member 行
   * 不存在抛 CONVERSATION_NOT_FOUND；无权限抛 CONVERSATION_FORBIDDEN。
   */
  async getVisibleOrThrow(
    conversationId: string,
    userId: string,
    orgId: string,
  ): Promise<Conversation> {
    const conv = await this.convRepo.findOne({ where: { id: conversationId } });
    if (!conv) throw new AppError(MainErrorCode.CONVERSATION_NOT_FOUND);

    if (conv.orgId !== orgId) {
      throw new AppError(MainErrorCode.CONVERSATION_NOT_FOUND);
    }

    if (conv.type === "dm") {
      const member = await this.memberRepo.findOne({
        where: { conversationId, userId },
      });
      if (!member) throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    }

    return conv;
  }

  /**
   * 保证 orgId 下至少存在一个 channel（默认「综合」）。
   * @WithLock（按 orgId）保证幂等，防并发重复建。
   * 内部是单表写，无需 @Transactional()。
   */
  @WithLock({ key: "channel:ensureDefault:#{0}", waitTimeout: 5000 })
  async ensureDefaultChannel(orgId: string, userId: string): Promise<void> {
    return this.createDefaultChannelIfEmpty(orgId, userId);
  }

  /**
   * 若 orgId 下无 channel，建默认「综合」频道。单表写，无需 @Transactional()。
   */
  private async createDefaultChannelIfEmpty(
    orgId: string,
    userId: string,
  ): Promise<void> {
    const count = await this.convRepo.count({
      where: { orgId, type: "channel" },
    });
    if (count > 0) return;

    await this.convRepo.save(
      this.convRepo.create({
        orgId,
        type: "channel",
        name: "综合",
        dmKey: null,
        createdBy: userId,
      }),
    );
  }

  /**
   * 单表 upsert：conversation_member(conversationId, userId).lastReadAt = now()。
   * 无需 @Transactional（单表写）。
   */
  async markRead(conversationId: string, userId: string): Promise<void> {
    await this.memberRepo.upsert(
      { conversationId, userId, lastReadAt: new Date() },
      { conflictPaths: ["conversationId", "userId"] },
    );
  }

  // ─── 私有辅助 ────────────────────────────────────────────────────

  /** Conversation 实体 → ConversationSummary（组合 MessageService + UserService）。 */
  private async toSummary(
    conv: Conversation,
    requestorId: string,
  ): Promise<ConversationSummary> {
    // 取 requestor 的 member 行（用于 lastReadAt）
    const member = await this.memberRepo.findOne({
      where: { conversationId: conv.id, userId: requestorId },
    });

    const [unreadCount, lastMsg] = await Promise.all([
      this.messageService.unreadCount(conv.id, member?.lastReadAt ?? null),
      this.messageService.lastMessage(conv.id),
    ]);

    let peer: ImPeer | null = null;
    if (conv.type === "dm" && conv.dmKey) {
      // dmKey = [a,b].sort().join(":")，对端是 dmKey 中另一个 userId
      const parts = conv.dmKey.split(":");
      const peerId = parts.find((id) => id !== requestorId) ?? parts[0];
      const peerUser = await this.userService.findById(peerId);
      if (peerUser) {
        peer = {
          userId: peerUser.id,
          displayName: peerUser.displayName,
          email: peerUser.email,
        };
      }
    }

    return {
      id: conv.id,
      type: conv.type as "channel" | "dm",
      name: conv.name,
      peer,
      unreadCount,
      lastMessage: lastMsg
        ? {
            content: lastMsg.content,
            senderId: lastMsg.senderId,
            createdAt: lastMsg.createdAt,
          }
        : null,
    };
  }
}
