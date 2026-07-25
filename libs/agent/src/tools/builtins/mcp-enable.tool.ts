import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpService } from "../../mcp/mcp.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { toggleMcpServerEnabled } from "./mcp-toggle.helper";

const ArgsSchema = z.object({
  name: z.string().min(1).describe("The MCP server name to enable"),
});
type Args = z.input<typeof ArgsSchema>;

/**
 * mcp_enable —— 启用一个此前被禁用的 MCP server（保留配置，重新建连接）。
 * 已是启用态幂等成功；不存在该 name 报错；无需用户确认。
 */
@Injectable()
@Tool()
export class McpEnableTool implements MeshbotTool<Args, string> {
  readonly name = "mcp_enable";
  readonly description =
    "Enable a previously-disabled MCP server by name. Idempotent — enabling an " +
    "already-enabled server succeeds as a no-op. Errors if the name does not " +
    "exist. Takes effect from the next conversation turn — tell the user so.";
  readonly schema = ArgsSchema;

  constructor(private readonly mcp: McpService) {}

  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    const result = await toggleMcpServerEnabled(this.mcp, args.name, true);
    if (result === "not-found") {
      return `MCP 服务器 "${args.name}" 不存在，无法启用。`;
    }
    if (result === "already") {
      return `MCP 服务器 "${args.name}" 已是启用状态。`;
    }
    return `已启用 MCP 服务器 "${args.name}"。下一轮对话生效——请告知用户。`;
  }
}
