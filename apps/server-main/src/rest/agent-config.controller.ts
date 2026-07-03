import { AppError } from "@meshbot/common";
import { MainErrorCode, OrgModelConfigService } from "@meshbot/main";
import type { AgentModelConfig } from "@meshbot/types";
import { Controller, Get } from "@nestjs/common";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";

/**
 * Agent 侧下发端点：读取组织已启用的模型配置（含明文 apiKey）。
 * 独立于 OrgModelConfigController（后者是 owner 管理视图，apiKey 打码）。
 */
@Controller("agent")
export class AgentConfigController {
  constructor(private readonly configs: OrgModelConfigService) {}

  /** orgId 取自当前身份（device token 请求时即 device.orgId）；无活跃组织抛 ORG_NOT_FOUND。 */
  @Get("model-configs")
  async listModelConfigs(
    @CurrentUser() u: JwtMainPayload,
  ): Promise<AgentModelConfig[]> {
    if (!u.orgId) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    return this.configs.listForAgent(u.orgId);
  }
}
