import { AppError, Transactional } from "@meshbot/common";
import type { OrgSummary } from "@meshbot/types-main";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { AppUser } from "../entities/app-user.entity";
import { Membership } from "../entities/membership.entity";
import { Organization } from "../entities/organization.entity";
import { MainErrorCode } from "../errors/main.error-codes";
import { MembershipService } from "./membership.service";

/**
 * Organization 的唯一归属 Service。建组织（跨表写 organization + membership +
 * app_user.active_org_id）走 @Transactional()；membership / app_user 的行在
 * 事务 manager 上写入，不额外注入它们的 Repository（check:repo 唯一写归属）。
 */
@Injectable()
export class OrgService {
  constructor(
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    private readonly memberships: MembershipService,
  ) {}

  /**
   * 创建组织：建 org + owner membership + 设活跃组织。返回组织摘要。
   *
   * 跨表行走事务 manager 派生的临时 Repository（`repo.manager` 在
   * @Transactional 内经 TxTypeOrmModule Proxy 解析为事务 EntityManager），
   * 不额外注入 Membership / AppUser 的 Repository（check:repo 唯一写归属）。
   */
  @Transactional()
  async persistNewOrg(userId: string, name: string): Promise<OrgSummary> {
    const org = await this.orgRepo.save(
      this.orgRepo.create({ name, ownerId: userId }),
    );
    const membershipRepo = this.orgRepo.manager.getRepository(Membership);
    await membershipRepo.save(
      membershipRepo.create({ orgId: org.id, userId, role: "owner" }),
    );
    const appUserRepo = this.orgRepo.manager.getRepository(AppUser);
    await appUserRepo.update({ id: userId }, { activeOrgId: org.id });
    return { id: org.id, name: org.name, role: "owner" };
  }

  /** 校验是 owner，否则抛 ORG_FORBIDDEN。 */
  async assertOwner(orgId: string, userId: string): Promise<void> {
    const role = await this.memberships.roleOf(orgId, userId);
    if (role !== "owner") {
      throw new AppError(MainErrorCode.ORG_FORBIDDEN);
    }
  }

  /** 取组织，不存在抛 ORG_NOT_FOUND。 */
  async getOrgOrThrow(orgId: string): Promise<Organization> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    if (!org) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    return org;
  }
}
