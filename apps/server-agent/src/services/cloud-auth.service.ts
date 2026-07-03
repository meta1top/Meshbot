import { AccountContextService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";

import { AccountRuntimeRegistry } from "../account/account-runtime.registry";
import { CloudClientService } from "../cloud/cloud-client.service";
import type { CloudProfileData } from "../cloud/cloud.types";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudIdentityService } from "./cloud-identity.service";

/** 本地 profile 视图（读身份镜像，不打云端）。 */
export interface LocalProfile {
  id: string;
  email: string;
  displayName: string;
  org: { id: string; name: string | null; role: string | null } | null;
}

/**
 * 云端认证编排：浏览器授权登录（DeviceAuthorizeService）落地后，
 * 本 Service 只负责登出 / 组织切换 / profile 读取 —— 全部用设备 token
 * （identity.deviceToken）代理云端调用，不再持有密码代理登录逻辑。
 */
@Injectable()
export class CloudAuthService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
    private readonly runtime: AccountRuntimeRegistry,
  ) {}

  /**
   * 登出：拆账号运行时（卸 MCP/技能/提示词缓存/云连接），置 loggedIn=false。
   * 本地 JWT 不主动吊销（无状态），登出语义 = 标记该云端账号已登出；profile /
   * 云端代理端点立即 401，纯本地路由在 JWT 剩余有效期内仍可用（单机桌面可接受）。
   */
  async logout(): Promise<void> {
    const id = this.account.getOrThrow();
    await this.runtime.teardownRuntime(id); // 卸 MCP/技能/提示词/云连接（含 relay.disconnect）
    await this.identity.setLoggedOut(id);
  }

  /**
   * 切换当前账号的活跃组织：代理云端 `/api/devices/switch-org`（设备 token），
   * 重拉 profile 刷新组织镜像。本地 access_token 不变（本地 JWT 的
   * sub=cloudUserId 不随 org 改变），前端刷 profile 即可。
   */
  async switchOrg(orgId: string): Promise<LocalProfile> {
    const cloudUserId = this.account.getOrThrow();
    const id = await this.identity.get(cloudUserId);
    if (!id?.deviceToken) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    await this.cloud.post<{ ok: true }>(
      "/api/devices/switch-org",
      { orgId },
      id.deviceToken,
    );
    const profile = await this.cloud.get<CloudProfileData>(
      "/api/auth/profile",
      id.deviceToken,
    );
    await this.identity.updateActiveOrg(
      cloudUserId,
      profile.activeOrg?.id ?? null,
      profile.activeOrg?.name ?? null,
      profile.activeOrg?.role ?? null,
    );
    return this.getProfile();
  }

  /**
   * 镜像自愈：指定账号有设备 token 但无活跃组织时，从云端拉一次 profile 刷新组织镜像。
   * 云端不可达 / 401 时静默失败（保持现状，由后续操作再触发）。
   * 由 Public 的 setup-status 路由调用（无账号上下文），cloudUserId 显式传入。
   */
  async trySyncActiveOrg(cloudUserId: string): Promise<void> {
    const id = await this.identity.get(cloudUserId);
    if (!id?.deviceToken || id.orgId) return;
    try {
      const profile = await this.cloud.get<CloudProfileData>(
        "/api/auth/profile",
        id.deviceToken,
      );
      if (profile.activeOrg) {
        await this.identity.updateActiveOrg(
          cloudUserId,
          profile.activeOrg.id,
          profile.activeOrg.name,
          profile.activeOrg.role,
        );
      }
    } catch {
      // 自愈失败不阻塞 setup-status；镜像组织信息保持缺省，等待后续调用再刷新
    }
  }

  /** 当前用户 profile（读本地镜像）。无镜像 → 401。 */
  async getProfile(): Promise<LocalProfile> {
    const id = await this.identity.get(this.account.getOrThrow());
    if (!id) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    return {
      id: id.cloudUserId,
      email: id.email,
      displayName: id.displayName,
      org: id.orgId ? { id: id.orgId, name: id.orgName, role: id.role } : null,
    };
  }
}
