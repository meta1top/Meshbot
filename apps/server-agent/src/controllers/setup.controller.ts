import { PROVIDERS } from "@meshbot/types-agent";
import { Controller, Get } from "@nestjs/common";

import { Public } from "../guards/jwt-auth.guard";
import { CloudIdentityService } from "../services/cloud-identity.service";
import { ModelConfigService } from "../services/model-config.service";

/** setup-status 四态：needs-login → needs-org → needs-model → ready。 */
@Controller("api")
export class SetupController {
  constructor(
    private readonly modelConfigService: ModelConfigService,
    private readonly identity: CloudIdentityService,
  ) {}

  @Public()
  @Get("setup-status")
  async getSetupStatus() {
    const id = await this.identity.get();
    if (!id?.cloudToken) {
      return { step: "needs-login", needsSetup: true };
    }
    if (!id.orgId) {
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
