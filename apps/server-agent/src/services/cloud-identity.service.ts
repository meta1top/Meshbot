import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { CloudIdentity } from "../entities/cloud-identity.entity";

const SINGLE_ROW_ID = "default";

/** CloudIdentity（单行镜像）的唯一归属 Service。 */
@Injectable()
export class CloudIdentityService {
  constructor(
    @InjectRepository(CloudIdentity)
    private readonly repo: Repository<CloudIdentity>,
  ) {}

  /** 取当前身份镜像；未登录返回 null。 */
  async get(): Promise<CloudIdentity | null> {
    return this.repo.findOne({ where: { id: SINGLE_ROW_ID } });
  }

  /** upsert 身份 + token + 活跃组织镜像。 */
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
    await this.repo.save({ id: SINGLE_ROW_ID, ...fields });
  }

  /** 仅刷新活跃组织镜像（拉到新 profile 后调用）。 */
  async updateActiveOrg(
    orgId: string | null,
    orgName: string | null,
    role: string | null,
  ): Promise<void> {
    await this.repo.update({ id: SINGLE_ROW_ID }, { orgId, orgName, role });
  }

  /** 清空身份（登出 / 云端 token 失效）。 */
  async clear(): Promise<void> {
    await this.repo.delete({ id: SINGLE_ROW_ID });
  }
}
