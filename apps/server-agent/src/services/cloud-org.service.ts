import { AccountContextService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";

import { CloudClientService } from "../cloud/cloud-client.service";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import type { CloudOrgSummary } from "../cloud/cloud.types";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudIdentityService } from "./cloud-identity.service";

/**
 * 云端组织端点的本地代理编排：持久化 token 的取用、云端调用、
 * 组织变更后的活跃组织镜像刷新。
 */
@Injectable()
export class CloudOrgService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly imRelay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /** 我的组织列表。 */
  async listMine(): Promise<CloudOrgSummary[]> {
    return this.cloud.get<CloudOrgSummary[]>("/api/orgs", await this.token());
  }

  /**
   * 创建组织，成功后用响应直接写活跃组织镜像。
   * 不再额外拉 profile —— 避免「建组织成功但 profile 往返失败 → 前端重试
   * 重复建组织」的窗口；建组织者必为 owner。
   */
  async createOrg(name: string): Promise<CloudOrgSummary> {
    const token = await this.token();
    const org = await this.cloud.post<CloudOrgSummary>(
      "/api/orgs",
      { name },
      token,
    );
    await this.identity.updateActiveOrg(
      this.account.getOrThrow(),
      org.id,
      org.name,
      "owner",
    );
    void this.imRelay.connect(this.account.getOrThrow());
    return org;
  }

  /** 接受邀请，成功后用响应直接写活跃组织镜像（受邀者为 member）。 */
  async acceptInvitation(
    inviteToken: string,
  ): Promise<{ orgId: string; orgName: string }> {
    const token = await this.token();
    const res = await this.cloud.post<{ orgId: string; orgName: string }>(
      "/api/orgs/invitations/accept",
      { token: inviteToken },
      token,
    );
    await this.identity.updateActiveOrg(
      this.account.getOrThrow(),
      res.orgId,
      res.orgName,
      "member",
    );
    void this.imRelay.connect(this.account.getOrThrow());
    return res;
  }

  /** owner 邀请成员（代理）。 */
  async invite(orgId: string, email: string): Promise<unknown> {
    return this.cloud.post(
      `/api/orgs/${orgId}/invitations`,
      { email },
      await this.token(),
    );
  }

  /** owner 查看 pending 邀请。 */
  async listInvitations(orgId: string): Promise<unknown> {
    return this.cloud.get(`/api/orgs/${orgId}/invitations`, await this.token());
  }

  /** 成员列表。 */
  async listMembers(orgId: string): Promise<unknown> {
    return this.cloud.get(`/api/orgs/${orgId}/members`, await this.token());
  }

  /** owner 重发邀请。 */
  async resendInvitation(
    orgId: string,
    invitationId: string,
  ): Promise<unknown> {
    return this.cloud.post(
      `/api/orgs/${orgId}/invitations/${invitationId}/resend`,
      undefined,
      await this.token(),
    );
  }

  /** owner 撤销邀请。 */
  async revokeInvitation(
    orgId: string,
    invitationId: string,
  ): Promise<unknown> {
    return this.cloud.del(
      `/api/orgs/${orgId}/invitations/${invitationId}`,
      await this.token(),
    );
  }

  private async token(): Promise<string> {
    const id = await this.identity.get(this.account.getOrThrow());
    if (!id?.deviceToken) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    return id.deviceToken;
  }
}
