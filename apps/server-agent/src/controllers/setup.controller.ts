import { AccountContextService } from "@meshbot/lib-agent";
import { PROVIDERS } from "@meshbot/types-agent";
import { Controller, Get, Headers } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import type { CloudIdentity } from "../entities/cloud-identity.entity";
import { Public } from "../guards/jwt-auth.guard";
import { CloudAuthService } from "../services/cloud-auth.service";
import { CloudIdentityService } from "../services/cloud-identity.service";
import { ModelConfigService } from "../services/model-config.service";

/**
 * setup-status 三态：needs-login → needs-model → ready。
 * 组织归属由云端浏览器授权登录流程保证，本地不再有 needs-org 分流。
 * needs-model 判定不变（hasEnabledModels），但本地模型配置写 REST 已下线——
 * needs-model 现在意味着该账号所属组织在云端未配置任何已启用模型（或云端同步尚未完成），
 * 需要去云端组织后台配置，而非本地新增（前端文案 Task 20 跟进）。
 */
@Controller("api")
export class SetupController {
  constructor(
    private readonly modelConfigService: ModelConfigService,
    private readonly identity: CloudIdentityService,
    private readonly cloudAuth: CloudAuthService,
    private readonly account: AccountContextService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Get("setup-status")
  async getSetupStatus(@Headers("authorization") authHeader?: string) {
    // 优先按请求携带的活跃账号 token 判定 —— 多账号下桌面/浏览器各自的活跃账号
    // 不同，不能再用 listLoggedIn()[0] 猜（会报错账号的状态，导致 UI 与实际错位）。
    // 无有效 token（首启 / 未登录）才回退到第一个已登录账号。
    const tokenUserId = this.extractCloudUserId(authHeader);
    let id: CloudIdentity | null = tokenUserId
      ? await this.identity.get(tokenUserId)
      : ((await this.identity.listLoggedIn())[0] ?? null);
    if (!id?.deviceToken) {
      return { step: "needs-login", needsSetup: true };
    }
    if (!id.orgId) {
      // 自愈：异地接受邀请等导致镜像与云端漂移时，拉一次 profile 刷新后再判定；
      // 自愈失败（云端不可达等）兜底用原 id 继续，不阻塞 needs-model/ready 判定
      await this.cloudAuth.trySyncActiveOrg(id.cloudUserId);
      id = (await this.identity.get(id.cloudUserId)) ?? id;
    }
    const hasModels = await this.account.run(id.cloudUserId, () =>
      this.modelConfigService.hasEnabledModels(),
    );
    if (!hasModels) {
      return { step: "needs-model", needsSetup: true };
    }
    return { step: "ready", needsSetup: false };
  }

  /** 从 Bearer token 解出 cloudUserId（sub）；无 / 过期 / 无效 → null（回退）。 */
  private extractCloudUserId(authHeader?: string): string | null {
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) return null;
    try {
      const payload = this.jwt.verify<{ sub?: string }>(token);
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }

  @Public()
  @Get("providers")
  getProviders() {
    return PROVIDERS;
  }
}
