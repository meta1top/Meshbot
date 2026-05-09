import { PROVIDERS } from "@meshbot/common";
import { Controller, Get } from "@nestjs/common";
import { Public } from "../guards/jwt-auth.guard";
import { AuthService } from "../services/auth.service";
import { ModelConfigService } from "../services/model-config.service";

@Controller("api")
export class SetupController {
  constructor(
    private readonly modelConfigService: ModelConfigService,
    private readonly authService: AuthService,
  ) {}

  @Public()
  @Get("setup-status")
  async getSetupStatus() {
    const { initialized } = await this.authService.getStatus();
    if (!initialized) {
      return { initialized: false, needsSetup: true, step: "register" };
    }
    const hasModels = await this.modelConfigService.hasEnabledModels();
    if (!hasModels) {
      return { initialized: true, needsSetup: true, step: "model" };
    }
    return { initialized: true, needsSetup: false, step: null };
  }

  @Public()
  @Get("providers")
  getProviders() {
    return PROVIDERS;
  }
}
