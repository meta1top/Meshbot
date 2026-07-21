import { AppError } from "@meshbot/common";
import {
  AgentSyncBatchDto,
  CloudAgentService,
  MainErrorCode,
} from "@meshbot/main";
import type { CloudAgent } from "@meshbot/main";
import type { AgentView } from "@meshbot/types-main";
import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";

/** 云端 Agent 注册表 Entity → web-main 列表视图（含云端主键 id，供网关寻址）。 */
function toAgentView(a: CloudAgent): AgentView {
  return {
    id: a.id,
    deviceId: a.deviceId,
    localAgentId: a.localAgentId,
    name: a.name,
    avatar: a.avatar,
    description: a.description,
  };
}

/**
 * Agent 注册表 REST（计划二 2b · T2）。瘦 Controller —— 对账 / 查询业务在
 * CloudAgentService，本类只做身份分流与视图映射。
 *
 * 两条路径段不同，故用空前缀 `@Controller()` + 方法上写全路径段
 * （NestJS 是 controller 前缀 + 方法路径拼接，方法路径前导 `/` 不会“逃逸”前缀，
 * 所以 `@Controller("agent")` 无法拼出 `/api/agents`）：
 * - `PUT /api/agent/agents`：device token 身份，设备侧全量推送对账。
 * - `GET  /api/agents`：user JWT 身份，web-main 列当前用户已注册 Agent。
 */
@ApiTags("agent-registry")
@Controller()
export class AgentRegistryController {
  constructor(private readonly agents: CloudAgentService) {}

  /**
   * 设备侧全量推送 remote_enabled Agent 元数据（按 deviceId 对账，软删消失项）。
   * 仅限 device token 身份：`u.deviceId` 为空（浏览器用户 JWT）→ 拒绝。
   */
  @Put("agent/agents")
  @ApiOperation({
    summary:
      "设备侧全量推送 remote_enabled Agent 元数据(对账，仅 device token)",
  })
  @ApiBody({ type: AgentSyncBatchDto })
  @ApiOkResponse({ description: "已对账" })
  async sync(
    @CurrentUser() u: JwtMainPayload,
    @Body() dto: AgentSyncBatchDto,
  ): Promise<void> {
    if (!u.deviceId) {
      throw new AppError(MainErrorCode.AGENT_REGISTRY_REQUIRES_DEVICE_TOKEN);
    }
    await this.agents.syncForDevice(
      u.deviceId,
      u.userId,
      u.orgId ?? null,
      dto.agents,
    );
  }

  /** web-main 列当前用户已注册（未软删）的远程 Agent。 */
  @Get("agents")
  @ApiOperation({ summary: "列出当前用户已注册的远程 Agent(user JWT)" })
  @ApiOkResponse({ description: "Agent 列表" })
  async list(@CurrentUser() u: JwtMainPayload): Promise<AgentView[]> {
    const rows = await this.agents.listForUser(u.userId);
    return rows.map(toAgentView);
  }
}
