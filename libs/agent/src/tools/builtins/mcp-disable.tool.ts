import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpService } from "../../mcp/mcp.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { toggleMcpServerEnabled } from "./mcp-toggle.helper";

const ArgsSchema = z.object({
  name: z.string().min(1).describe("The MCP server name to disable"),
});
type Args = z.input<typeof ArgsSchema>;

/**
 * mcp_disable —— 禁用一个 MCP server（配置保留、不再建连接）。
 * 已是禁用态幂等成功；不存在该 name 报错；无需用户确认。
 */
@Injectable()
@Tool()
export class McpDisableTool implements MeshbotTool<Args, string> {
  readonly name = "mcp_disable";
  readonly description =
    "Disable an MCP server by name — its config is kept but no connection is " +
    "established. Idempotent — disabling an already-disabled server succeeds as " +
    "a no-op. Errors if the name does not exist. Takes effect immediately — its " +
    "tools are gone from this very turn onward.";
  readonly schema = ArgsSchema;

  constructor(private readonly mcp: McpService) {}

  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    const result = await toggleMcpServerEnabled(this.mcp, args.name, false);
    if (result === "not-found") {
      return `MCP 服务器 "${args.name}" 不存在，无法禁用。`;
    }
    if (result === "already") {
      return `MCP 服务器 "${args.name}" 已是禁用状态。`;
    }
    return `已禁用 MCP 服务器 "${args.name}"，已生效（本轮对话内立即不可用）——请告知用户。`;
  }
}
