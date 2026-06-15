import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { CloudIdentity } from "../entities/cloud-identity.entity";

/**
 * CloudIdentity（v3 多行镜像）的唯一归属 Service。
 *
 * CloudIdentity 是账号注册表本身——cloud_user_id 是身份键而非「当前账号」过滤字段，
 * 故本 Service 合法地注入原始 Repository 并按 cloudUserId 查询（check:scope 显式豁免，
 * 不用 ScopedRepository）。
 */
@Injectable()
export class CloudIdentityService {
  constructor(
    @InjectRepository(CloudIdentity)
    private readonly repo: Repository<CloudIdentity>,
  ) {}

  /** 取指定账号镜像；不存在返回 null。 */
  async get(cloudUserId: string): Promise<CloudIdentity | null> {
    return this.repo.findOne({ where: { cloudUserId } });
  }

  /** 登录时 upsert 该账号镜像并置 loggedIn=true。 */
  async upsert(fields: {
    cloudUserId: string;
    email: string;
    displayName: string;
    cloudToken: string;
    cloudTokenExpiresAt: string | null;
    orgId: string | null;
    orgName: string | null;
    role: string | null;
  }): Promise<void> {
    await this.repo.save({ ...fields, loggedIn: true });
  }

  /** 更新某账号当前组织。 */
  async updateActiveOrg(
    cloudUserId: string,
    orgId: string | null,
    orgName: string | null,
    role: string | null,
  ): Promise<void> {
    await this.repo.update({ cloudUserId }, { orgId, orgName, role });
  }

  /** 登出：置 loggedIn=false，保留行与 token（离线可用）。 */
  async setLoggedOut(cloudUserId: string): Promise<void> {
    await this.repo.update({ cloudUserId }, { loggedIn: false });
  }

  /** 当前已登录账号列表（重启恢复用）。 */
  async listLoggedIn(): Promise<CloudIdentity[]> {
    return this.repo.find({ where: { loggedIn: true } });
  }
}
