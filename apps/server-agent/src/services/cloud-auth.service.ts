import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { CloudClientService } from "../cloud/cloud-client.service";
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
  ) {}

  /** 代理云端注册，成功后写镜像并签本地 JWT。 */
  async register(input: RegisterInput): Promise<LocalTokenResponse> {
    const auth = await this.cloud.post<CloudAuthData>(
      "/api/auth/register",
      input,
    );
    return this.afterCloudAuth(auth);
  }

  /** 代理云端登录，成功后写镜像并签本地 JWT。 */
  async login(input: Credentials): Promise<LocalTokenResponse> {
    const auth = await this.cloud.post<CloudAuthData>("/api/auth/login", input);
    return this.afterCloudAuth(auth);
  }

  /** 登出：清空本地身份镜像（本地 JWT 由前端自行丢弃）。 */
  async logout(): Promise<void> {
    await this.identity.clear();
  }

  /** 当前用户 profile（读本地镜像）。无镜像 → 401。 */
  async getProfile(): Promise<LocalProfile> {
    const id = await this.identity.get();
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
    await this.identity.upsert({
      cloudUserId: auth.user.id,
      email: auth.user.email,
      displayName: auth.user.displayName,
      cloudToken: auth.token,
      cloudTokenExpiresAt: null,
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
