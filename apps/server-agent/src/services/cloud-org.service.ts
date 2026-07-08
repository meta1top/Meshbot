import { AccountContextService } from "@meshbot/lib-agent";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";

import { CloudClientService } from "../cloud/cloud-client.service";
import type { CloudOrgSummary } from "../cloud/cloud.types";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudIdentityService } from "./cloud-identity.service";

/**
 * 云端组织端点的本地代理编排（精简版）：
 * 仅保留 IM 与组织切换依赖的端点（我的组织列表、成员列表）。
 * 组织管理操作（建组织/邀请/接受邀请）已转移到云端 web-main。
 */
@Injectable()
export class CloudOrgService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
  ) {}

  /** 我的组织列表。 */
  async listMine(): Promise<CloudOrgSummary[]> {
    return this.cloud.get<CloudOrgSummary[]>("/api/orgs", await this.token());
  }

  /** 成员列表。 */
  async listMembers(orgId: string): Promise<unknown> {
    return this.cloud.get(`/api/orgs/${orgId}/members`, await this.token());
  }

  private async token(): Promise<string> {
    const id = await this.identity.get(this.account.getOrThrow());
    if (!id?.deviceToken) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    return id.deviceToken;
  }
}
