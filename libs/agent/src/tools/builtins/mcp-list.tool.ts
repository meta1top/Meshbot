import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AccountContextService } from "../../account/account-context.service";
import { AgentContextService } from "../../account/agent-context.service";
import { isStdioServer } from "../../mcp/mcp.schema";
import { McpService } from "../../mcp/mcp.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const McpListArgsSchema = z.object({}).strict();
type McpListArgs = z.infer<typeof McpListArgsSchema>;

/**
 * mcp_list —— 列出当前 Agent mcp.json 里配置的全部 MCP server（含禁用项）
 * 与本轮运行态（已加载的 server 与工具名清单）。与 system:mcp 系统消息同
 * 数据源（`McpService.loadConfig()`），供 agent 主动查询最新状态
 * （system:mcp 只在每轮开始时刷新一次）。
 */
@Injectable()
@Tool()
export class McpListTool implements MeshbotTool<McpListArgs, string> {
  readonly name = "mcp_list";
  readonly description =
    "List all MCP servers configured for this agent (mcp.json), including " +
    "disabled ones, plus this run's loaded tool count per server. Use this before " +
    "deciding to install/uninstall/enable/disable a server.";
  readonly schema = McpListArgsSchema;

  constructor(
    private readonly mcp: McpService,
    private readonly account: AccountContextService,
    private readonly agentCtx: AgentContextService,
  ) {}

  async execute(_args: McpListArgs, _ctx: ToolContext): Promise<string> {
    const servers = this.mcp.loadConfig()?.mcpServers ?? {};
    const entries = Object.entries(servers);
    if (entries.length === 0) {
      return "当前未配置任何 MCP 服务器。需要外部工具能力时可用 mcp_install 安装（需用户确认）。";
    }
    const loaded = this.mcp.getLoadedToolNames(
      this.account.getOrThrow(),
      this.agentCtx.getOrThrow(),
    );
    const list = entries.map(([name, server]) => {
      const protocol = isStdioServer(server)
        ? "stdio"
        : (server.transport ?? "streamable_http");
      const prefix = `mcp__${name}__`;
      const loadedToolCount = loaded
        ? [...loaded].filter((n) => n.startsWith(prefix)).length
        : null; // null = 本轮尚未加载，不是 0 个工具
      return {
        name,
        protocol,
        enabled: server.enabled !== false,
        loadedToolCount,
      };
    });
    return JSON.stringify({ servers: list }, null, 2);
  }
}
