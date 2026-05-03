import { PROVIDERS } from "@anybot/common";
import { Controller, Get } from "@nestjs/common";
import { ModelConfigService } from "../services/model-config.service";

@Controller("api")
export class SetupController {
  constructor(private readonly modelConfigService: ModelConfigService) {}

  @Get("setup-status")
  async getSetupStatus() {
    const hasModels = await this.modelConfigService.hasEnabledModels();
    return { needsSetup: !hasModels };
  }

  @Get("providers")
  getProviders() {
    return PROVIDERS;
  }
}
