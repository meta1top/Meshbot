import { PROVIDERS } from "@meshbot/types-agent";
import { Controller, Get } from "@nestjs/common";

import type { CloudIdentity } from "../entities/cloud-identity.entity";
import { Public } from "../guards/jwt-auth.guard";
import { CloudAuthService } from "../services/cloud-auth.service";
import { CloudIdentityService } from "../services/cloud-identity.service";
import { ModelConfigService } from "../services/model-config.service";

/** setup-status 四态：needs-login → needs-org → needs-model → ready。 */
@Controller("api")
export class SetupController {
  constructor(
    private readonly modelConfigService: ModelConfigService,
    private readonly identity: CloudIdentityService,
    private readonly cloudAuth: CloudAuthService,
  ) {}

  @Public()
  @Get("setup-status")
  async getSetupStatus() {
    // Public 路由无账号上下文：以「是否有已登录账号」判定（v3 多行，取第一个已登录账号）
    let id: CloudIdentity | null =
      (await this.identity.listLoggedIn())[0] ?? null;
    if (!id?.cloudToken) {
      return { step: "needs-login", needsSetup: true };
    }
    if (!id.orgId) {
      // 自愈：异地接受邀请等导致镜像与云端漂移时，拉一次 profile 刷新后再判定
      await this.cloudAuth.trySyncActiveOrg(id.cloudUserId);
      id = await this.identity.get(id.cloudUserId);
    }
    if (!id?.orgId) {
      return { step: "needs-org", needsSetup: true };
    }
    const hasModels = await this.modelConfigService.hasEnabledModels();
    if (!hasModels) {
      return { step: "needs-model", needsSetup: true };
    }
    return { step: "ready", needsSetup: false };
  }

  @Public()
  @Get("providers")
  getProviders() {
    return PROVIDERS;
  }
}
