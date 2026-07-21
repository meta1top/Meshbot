import type { RemoteAgentView } from "@meshbot/types-agent";
import { Controller, Get } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";

import { RemoteAgentsService } from "../services/remote-agents.service";

/**
 * 远程 Agent 集合端点（计划二 2c·A1）：列出同账号其他设备上已注册的远程 Agent。
 * 受本地 JWT 保护，瘦 Controller，业务在 RemoteAgentsService。
 */
@Controller("api")
export class RemoteAgentsController {
  constructor(private readonly remoteAgents: RemoteAgentsService) {}

  /** 列出其他设备上的远程 Agent（含宿主设备名 + 在线态）。 */
  @Get("remote-agents")
  @ApiOperation({ summary: "列出其他设备上的远程 Agent" })
  list(): Promise<RemoteAgentView[]> {
    return this.remoteAgents.listRemoteAgents();
  }
}
