import { PROVIDERS } from "@meshbot/types-agent";
import { Controller, Get } from "@nestjs/common";

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
    let id = await this.identity.get();
    if (!id?.cloudToken) {
      return { step: "needs-login", needsSetup: true };
    }
    if (!id.orgId) {
      // 自愈：异地接受邀请等导致镜像与云端漂移时，拉一次 profile 刷新后再判定
      await this.cloudAuth.trySyncActiveOrg();
      id = await this.identity.get();
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
