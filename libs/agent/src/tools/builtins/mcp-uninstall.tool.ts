import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpService } from "../../mcp/mcp.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  name: z.string().min(1).describe("The MCP server name to remove"),
});
type Args = z.input<typeof ArgsSchema>;

/** 不存在该 server 时用来短路 mutator，不落盘不 teardown。 */
class McpUninstallNotFound extends Error {}

/**
 * mcp_uninstall —— 从当前 Agent 的 mcp.json 删除一个 MCP server 配置。
 * 不存在该 name 报错；无需用户确认（对照 spec：仅 install 弹卡）。
 */
@Injectable()
@Tool()
export class McpUninstallTool implements MeshbotTool<Args, string> {
  readonly name = "mcp_uninstall";
  readonly description =
    "Remove an MCP server configuration from this agent's mcp.json by name. " +
    "Errors if the name does not exist. Takes effect from the next conversation " +
    "turn — tell the user so.";
  readonly schema = ArgsSchema;

  constructor(private readonly mcp: McpService) {}

  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    try {
      await this.mcp.updateConfig((config) => {
        if (!config.mcpServers[args.name]) {
          throw new McpUninstallNotFound();
        }
        const rest = { ...config.mcpServers };
        delete rest[args.name];
        return { mcpServers: rest };
      });
    } catch (err) {
      if (err instanceof McpUninstallNotFound) {
        return `MCP 服务器 "${args.name}" 不存在，无法卸载。`;
      }
      throw err;
    }
    return `已卸载 MCP 服务器 "${args.name}"。下一轮对话生效——请告知用户。`;
  }
}
