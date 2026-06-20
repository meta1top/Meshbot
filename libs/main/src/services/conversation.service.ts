import { AppError, Transactional, WithLock } from "@meshbot/common";
import type {
  ChannelMember,
  ConversationSummary,
  ImPeer,
} from "@meshbot/types";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { Conversation } from "../entities/conversation.entity";
import { ConversationMember } from "../entities/conversation-member.entity";
import { MainErrorCode } from "../errors/main.error-codes";
import { MembershipService } from "./membership.service";
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
 * - 会话列表（listConversations）：公开频道 ∪ 成员所在私有频道/DM
 * - 已读标记（markRead）：find + save（雪花 id 靠 @BeforeInsert，不能用 upsert/insert），无需事务
 * - 添加成员（addMember）：find + create+save（幂等，同雪花 id 原因），无需事务
 * - 退出频道（leave）：单表 delete，无需事务
 * - 成员列表（listMembers）：只读，无需事务
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
    private readonly membership: MembershipService,
  ) {}

  /**
   * 列出 userId 在 orgId 内可见的会话。
   * = 公开频道 ∪ userId 所在私有频道 ∪ userId 参与的 DM。
   * 先调 ensureDefaultChannel 保证至少一个频道。
   */
  async listConversations(
    userId: string,
    orgId: string,
  ): Promise<ConversationSummary[]> {
    await this.ensureDefaultChannel(orgId, userId);

    const publicChannels = await this.convRepo.find({
      where: { orgId, type: "channel", visibility: "public" },
    });

    const myMembers = await this.memberRepo.find({ where: { userId } });
    const myConvIds = myMembers.map((m) => m.conversationId);

    let memberConvs: Conversation[] = [];
    if (myConvIds.length > 0) {
      const candidates = await this.convRepo.find({ where: { orgId } });
      memberConvs = candidates.filter(
        (c) =>
          myConvIds.includes(c.id) &&
          (c.type === "dm" ||
            (c.type === "channel" && c.visibility === "private")),
      );
    }

    const allConvs = [...publicChannels, ...memberConvs];
    return Promise.all(allConvs.map((conv) => this.toSummary(conv, userId)));
  }

  /**
   * 建频道。跨表写（conversation + member），走 @Transactional()。
   * 命名遵循 *InTx 约定（check:naming）。
   * visibility='private' 时将 memberIds 中属于组织的成员一并写入。
   */
  @Transactional()
  async persistChannelInTx(
    orgId: string,
    name: string,
    createdBy: string,
    visibility: "public" | "private" = "public",
    memberIds: string[] = [],
  ): Promise<ConversationSummary> {
    const conv = await this.convRepo.save(
      this.convRepo.create({
        orgId,
        type: "channel",
        name,
        dmKey: null,
        createdBy,
        visibility,
      }),
    );
    const memberRepo = this.convRepo.manager.getRepository(ConversationMember);
    let ids = [createdBy];
    if (visibility === "private" && memberIds.length > 0) {
      const checks = await Promise.all(
        memberIds.map(async (id) =>
          (await this.membership.isMember(orgId, id)) ? id : null,
        ),
      );
      ids = [
        ...new Set([
          createdBy,
          ...checks.filter((x): x is string => x !== null),
        ]),
      ];
    }
    await memberRepo.save(
      ids.map((userId) =>
        memberRepo.create({
          conversationId: conv.id,
          userId,
          lastReadAt: null,
        }),
      ),
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
   * - channel(public) → conversation.orgId === orgId 即可
   * - channel(private) → 必须有 conversation_member 行
   * - dm → 必须有 conversation_member 行
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

    const requiresMembership =
      conv.type === "dm" ||
      (conv.type === "channel" && conv.visibility === "private");
    if (requiresMembership) {
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
   * 标记已读：conversation_member(conversationId, userId).lastReadAt = now()。
   * 返回写入的 lastReadAt（Date），供 Gateway 广播多端同步。
   *
   * 必须用 find + save（不能用 upsert/insert）：id 是雪花 PK，靠 @BeforeInsert 生成，
   * 而 upsert/insert 走 plain-object 不触发该 hook → id 为 NULL 违反 NOT NULL，整条
   * markRead 静默失败、lastReadAt 永远写不进（曾导致未读永不清零）。create()+save()
   * 才会触发 @BeforeInsert（与 persistDmInTx 同）。单表写，无需 @Transactional。
   * 公开频道首次已读时该成员行可能不存在，故走 insert 分支创建。
   */
  async markRead(conversationId: string, userId: string): Promise<Date> {
    const now = new Date();
    const member = await this.memberRepo.findOne({
      where: { conversationId, userId },
    });
    if (member) {
      member.lastReadAt = now;
      await this.memberRepo.save(member);
      return now;
    }
    await this.memberRepo.save(
      this.memberRepo.create({
        conversationId,
        userId,
        lastReadAt: now,
      }),
    );
    return now;
  }

  /** 拉人：actor 必须是该私有频道成员；target 必须是本组织成员；幂等。返回对 target 的 summary。 */
  async addMember(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ summary: ConversationSummary; orgId: string }> {
    const conv = await this.convRepo.findOne({ where: { id: conversationId } });
    if (!conv) throw new AppError(MainErrorCode.CONVERSATION_NOT_FOUND);
    if (conv.type !== "channel" || conv.visibility !== "private") {
      throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    }
    const actorMember = await this.memberRepo.findOne({
      where: { conversationId, userId: actorUserId },
    });
    if (!actorMember) throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    const targetIsOrgMember = await this.membership.isMember(
      conv.orgId,
      targetUserId,
    );
    if (!targetIsOrgMember)
      throw new AppError(MainErrorCode.CHANNEL_MEMBER_INVALID);
    const existing = await this.memberRepo.findOne({
      where: { conversationId, userId: targetUserId },
    });
    if (!existing) {
      // create()+save() 触发 @BeforeInsert 生成雪花 id（upsert/insert 不触发 → id NULL）；
      // 已是成员则不动（幂等，且不覆盖其已有 lastReadAt）。
      await this.memberRepo.save(
        this.memberRepo.create({
          conversationId,
          userId: targetUserId,
          lastReadAt: null,
        }),
      );
    }
    const summary = await this.toSummary(conv, targetUserId);
    return { summary, orgId: conv.orgId };
  }

  /** 成员主动退出私有频道。 */
  async leave(
    conversationId: string,
    userId: string,
  ): Promise<{ orgId: string }> {
    const conv = await this.convRepo.findOne({ where: { id: conversationId } });
    if (!conv) throw new AppError(MainErrorCode.CONVERSATION_NOT_FOUND);
    if (conv.type !== "channel" || conv.visibility !== "private") {
      throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    }
    const member = await this.memberRepo.findOne({
      where: { conversationId, userId },
    });
    if (!member) throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    await this.memberRepo.delete({ conversationId, userId });
    return { orgId: conv.orgId };
  }

  /** 成员列表（调用者需可见该会话）。 */
  async listMembers(
    conversationId: string,
    userId: string,
    orgId: string,
  ): Promise<ChannelMember[]> {
    await this.getVisibleOrThrow(conversationId, userId, orgId);
    const members = await this.memberRepo.find({ where: { conversationId } });
    const out: ChannelMember[] = [];
    for (const m of members) {
      const u = await this.userService.findById(m.userId);
      if (u)
        out.push({ userId: u.id, displayName: u.displayName, email: u.email });
    }
    return out;
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
      this.messageService.unreadCount(
        conv.id,
        member?.lastReadAt ?? null,
        requestorId,
      ),
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
      visibility: (conv.visibility ?? "public") as "public" | "private",
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
