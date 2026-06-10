import { randomBytes } from "node:crypto";
import { AppError, Transactional, WithLock } from "@meshbot/common";
import type { InvitationSummary } from "@meshbot/types-main";
import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, MoreThan, type Repository } from "typeorm";

import { AppUser } from "../entities/app-user.entity";
import { Invitation } from "../entities/invitation.entity";
import { Membership } from "../entities/membership.entity";
import { Organization } from "../entities/organization.entity";
import { MainErrorCode } from "../errors/main.error-codes";
import {
  type AppConfigInvitation,
  INVITATION_CONFIG,
} from "./invitation.config";

/** 邀请被接受后的结果。 */
export interface AcceptResult {
  orgId: string;
  orgName: string;
}

/**
 * Invitation 的唯一归属 Service。
 * - 建邀请：单表写（仅 invitation），不需 @Transactional。
 * - 接受邀请：跨表写（membership + invitation + 可能的 app_user.active_org_id）→
 *   事务；并发重复接受用 @WithLock（按 token）在事务外层保护幂等。
 */
@Injectable()
export class InvitationService {
  constructor(
    @InjectRepository(Invitation)
    private readonly inviteRepo: Repository<Invitation>,
    @Inject(INVITATION_CONFIG)
    private readonly config: AppConfigInvitation,
  ) {}

  /**
   * owner 创建邀请；同组织同邮箱已有 pending 则幂等复用。返回实体（含 token）。
   * 已有 pending 但已过期 → 原行刷新 token 与有效期（部分唯一索引
   * idx_invitation_org_email_pending 阻止再插一行，必须就地刷新避免死锁）。
   *
   * tx-check: ignore — update 与 save 分属互斥分支，每次执行只有一处单表写。
   */
  async createInvitation(
    orgId: string,
    invitedBy: string,
    email: string,
  ): Promise<Invitation> {
    const existing = await this.inviteRepo.findOne({
      where: { orgId, email, status: "pending" },
    });
    if (existing) {
      if (existing.expiresAt.getTime() >= Date.now()) return existing;
      const refresh = {
        token: randomBytes(24).toString("hex"),
        status: "pending" as const,
        invitedBy,
        expiresAt: new Date(
          Date.now() + this.config.expiresDays * 24 * 60 * 60 * 1000,
        ),
      };
      await this.inviteRepo.update({ id: existing.id }, refresh);
      return Object.assign(existing, refresh);
    }
    const invite = this.inviteRepo.create({
      orgId,
      email,
      token: randomBytes(24).toString("hex"),
      status: "pending",
      invitedBy,
      expiresAt: new Date(
        Date.now() + this.config.expiresDays * 24 * 60 * 60 * 1000,
      ),
      acceptedBy: null,
      acceptedAt: null,
    });
    return this.inviteRepo.save(invite);
  }

  /** owner 查看组织的 pending 邀请（不含已过期）。 */
  async listPending(orgId: string): Promise<InvitationSummary[]> {
    const rows = await this.inviteRepo.find({
      where: { orgId, status: "pending", expiresAt: MoreThan(new Date()) },
      order: { createdAt: "DESC" },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      status: r.status as InvitationSummary["status"],
      token: r.token,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** owner 撤销邀请（仅 pending 可撤销）。 */
  async revoke(id: string): Promise<void> {
    await this.inviteRepo.update(
      { id, status: "pending" },
      { status: "revoked" },
    );
  }

  /** 按 id 取邀请（owner 重发邮件用）。 */
  async findById(id: string): Promise<Invitation | null> {
    return this.inviteRepo.findOne({ where: { id } });
  }

  /** 接受邀请。幂等：已是成员直接成功。锁包事务（check:lock-tx）。 */
  @WithLock({ key: "invitation:accept:#{0}", waitTimeout: 5000 })
  async acceptInvitation(token: string, userId: string): Promise<AcceptResult> {
    return this.persistAccept(token, userId);
  }

  /**
   * 接受邀请的事务体。跨表行走事务 manager 派生的临时 Repository
   * （`repo.manager` 在 @Transactional 内经 TxTypeOrmModule Proxy 解析为
   * 事务 EntityManager），不额外注入其他 Entity 的 Repository（check:repo）。
   */
  @Transactional()
  private async persistAccept(
    token: string,
    userId: string,
  ): Promise<AcceptResult> {
    const manager = this.inviteRepo.manager;
    const invite = await this.inviteRepo.findOne({ where: { token } });
    if (!invite || invite.status === "revoked") {
      throw new AppError(MainErrorCode.INVITATION_INVALID);
    }

    const org = await manager.findOne(Organization, {
      where: { id: invite.orgId },
    });
    if (!org) throw new AppError(MainErrorCode.ORG_NOT_FOUND);

    const already = await manager.count(Membership, {
      where: { orgId: invite.orgId, userId },
    });
    if (already > 0) {
      return { orgId: org.id, orgName: org.name };
    }

    if (invite.status !== "pending") {
      throw new AppError(MainErrorCode.INVITATION_INVALID);
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new AppError(MainErrorCode.INVITATION_EXPIRED);
    }

    const membershipRepo = manager.getRepository(Membership);
    await membershipRepo.save(
      membershipRepo.create({
        orgId: invite.orgId,
        userId,
        role: "member",
      }),
    );
    await this.inviteRepo.update(
      { id: invite.id },
      { status: "accepted", acceptedBy: userId, acceptedAt: new Date() },
    );
    // 仅当用户还没有活跃组织时设为该组织（不覆盖已有选择）
    const appUserRepo = manager.getRepository(AppUser);
    await appUserRepo.update(
      { id: userId, activeOrgId: IsNull() },
      { activeOrgId: invite.orgId },
    );

    return { orgId: org.id, orgName: org.name };
  }
}
