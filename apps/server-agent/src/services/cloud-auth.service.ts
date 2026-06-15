import { AccountContextService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { CloudClientService } from "../cloud/cloud-client.service";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import type { CloudAuthData, CloudProfileData } from "../cloud/cloud.types";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudIdentityService } from "./cloud-identity.service";

/** 本地 access_token 响应（与旧 LoginResponse 兼容，前端契约不变）。 */
export interface LocalTokenResponse {
  access_token: string;
}

interface Credentials {
  email: string;
  password: string;
}

interface RegisterInput extends Credentials {
  displayName: string;
}

/** 本地 profile 视图（读身份镜像，不打云端）。 */
export interface LocalProfile {
  id: string;
  email: string;
  displayName: string;
  org: { id: string; name: string | null; role: string | null } | null;
}

/**
 * 云端认证编排（方案 A）：代理云端 register/login，写本地身份镜像，
 * 签发本地 JWT 给浏览器。云端 token 只存 cloud_identity，不下发浏览器。
 */
@Injectable()
export class CloudAuthService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly jwt: JwtService,
    private readonly imRelay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /** 代理云端注册，成功后写镜像并签本地 JWT，并尝试建立 IM 中继连接。 */
  async register(input: RegisterInput): Promise<LocalTokenResponse> {
    const auth = await this.cloud.post<CloudAuthData>(
      "/api/auth/register",
      input,
    );
    const result = await this.afterCloudAuth(auth);
    void this.imRelay.connect();
    return result;
  }

  /** 代理云端登录，成功后写镜像并签本地 JWT，并建立 IM 中继连接。 */
  async login(input: Credentials): Promise<LocalTokenResponse> {
    const auth = await this.cloud.post<CloudAuthData>("/api/auth/login", input);
    const result = await this.afterCloudAuth(auth);
    void this.imRelay.connect();
    return result;
  }

  /**
   * 登出：置当前账号 loggedIn=false（保留行与 token，离线可用）。
   * 本地 JWT 不主动吊销（无状态），登出语义 = 标记该云端账号已登出；profile /
   * 云端代理端点立即 401，纯本地路由在 JWT 剩余有效期内仍可用（单机桌面可接受）。
   * 完整运行时拆解（teardownRuntime）见 Task 4.3。
   */
  async logout(): Promise<void> {
    const id = this.account.getOrThrow();
    this.imRelay.disconnect();
    await this.identity.setLoggedOut(id);
  }

  /**
   * 镜像自愈：指定账号有 token 但无活跃组织时，从云端拉一次 profile 刷新组织镜像。
   * 云端不可达 / 401 时静默失败（保持现状，由后续操作再触发）。
   * 由 Public 的 setup-status 路由调用（无账号上下文），cloudUserId 显式传入。
   */
  async trySyncActiveOrg(cloudUserId: string): Promise<void> {
    const id = await this.identity.get(cloudUserId);
    if (!id?.cloudToken || id.orgId) return;
    try {
      const profile = await this.cloud.get<CloudProfileData>(
        "/api/auth/profile",
        id.cloudToken,
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
      // 自愈失败不阻塞 setup-status；保持 needs-org 由用户操作触发后续刷新
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

  /** 云端 auth 成功后：拉 profile、写镜像、签本地 JWT。 */
  private async afterCloudAuth(
    auth: CloudAuthData,
  ): Promise<LocalTokenResponse> {
    const profile = await this.cloud.get<CloudProfileData>(
      "/api/auth/profile",
      auth.token,
    );
    const expiresAtIso = computeExpiresAt(auth.expiresIn);
    await this.identity.upsert({
      cloudUserId: auth.user.id,
      email: auth.user.email,
      displayName: auth.user.displayName,
      cloudToken: auth.token,
      cloudTokenExpiresAt: expiresAtIso,
      orgId: profile.activeOrg?.id ?? null,
      orgName: profile.activeOrg?.name ?? null,
      role: profile.activeOrg?.role ?? null,
    });
    const access_token = this.jwt.sign({
      sub: auth.user.id,
      email: auth.user.email,
    });
    return { access_token };
  }
}

/** 把云端 expiresIn（如 "7d" / "12h"）换算为 ISO 过期时间；无法解析返回 null。 */
function computeExpiresAt(expiresIn: string): string | null {
  const m = /^(\d+)([smhd])$/.exec(expiresIn);
  if (!m) return null;
  const n = Number(m[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    m[2] as "s" | "m" | "h" | "d"
  ];
  return new Date(Date.now() + n * unitMs).toISOString();
}
