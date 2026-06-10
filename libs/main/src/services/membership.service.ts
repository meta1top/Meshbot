import type { MemberSummary, OrgRole, OrgSummary } from "@meshbot/types-main";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { AppUser } from "../entities/app-user.entity";
import { Membership } from "../entities/membership.entity";
import { Organization } from "../entities/organization.entity";

/**
 * Membership 的唯一归属 Service。组织成员关系的读写。
 * Organization / AppUser 仅在此做只读 join 拼装摘要；它们的写各归
 * OrgService / UserService（check:repo 唯一写归属）。
 */
@Injectable()
export class MembershipService {
  constructor(
    @InjectRepository(Membership)
    private readonly membershipRepo: Repository<Membership>,
  ) {}

  /** 列出某用户的所有组织（带角色）。 */
  async listOrgsForUser(userId: string): Promise<OrgSummary[]> {
    return this.membershipRepo
      .createQueryBuilder("m")
      .innerJoin(Organization, "o", "o.id = m.org_id")
      .where("m.user_id = :userId", { userId })
      .select("o.id", "id")
      .addSelect("o.name", "name")
      .addSelect("m.role", "role")
      .getRawMany<OrgSummary>();
  }

  /** 列出某组织的成员（带 email/displayName）。 */
  async listMembers(orgId: string): Promise<MemberSummary[]> {
    return this.membershipRepo
      .createQueryBuilder("m")
      .innerJoin(AppUser, "u", "u.id = m.user_id")
      .where("m.org_id = :orgId", { orgId })
      .select("m.user_id", "userId")
      .addSelect("u.email", "email")
      .addSelect("u.display_name", "displayName")
      .addSelect("m.role", "role")
      .getRawMany<MemberSummary>();
  }

  /** 用户是否为某组织成员。 */
  async isMember(orgId: string, userId: string): Promise<boolean> {
    const count = await this.membershipRepo.count({ where: { orgId, userId } });
    return count > 0;
  }

  /** 用户在某组织的角色；非成员返回 null。 */
  async roleOf(orgId: string, userId: string): Promise<OrgRole | null> {
    const row = await this.membershipRepo.findOne({ where: { orgId, userId } });
    return (row?.role as OrgRole) ?? null;
  }
}
