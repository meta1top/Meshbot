import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import { McpServerConfigSchema } from "../../mcp/mcp.schema";
import { McpService } from "../../mcp/mcp.service";
import { MCP_CONFIRM_PORT, type McpConfirmPort } from "../mcp-confirm.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  name: z.string().min(1).describe("Unique MCP server name (mcp.json key)"),
  server: McpServerConfigSchema,
});
type Args = z.input<typeof ArgsSchema>;

/** 落盘前的最终查重命中——用来短路 `updateConfig` mutator，不落盘不 teardown。 */
class McpInstallDuplicate extends Error {}

/**
 * mcp_install —— 安装一个新 MCP server（stdio 或 http/sse）到当前 Agent 的
 * mcp.json。安装需要用户 HITL 确认（stdio 意味着授权一个常驻本地命令，且
 * 配置会持久化）；`name` 已存在直接报错，不静默覆盖（改配置走先
 * mcp_uninstall 或人工编辑抽屉）。
 */
@Injectable()
@Tool()
export class McpInstallTool implements MeshbotTool<Args, string> {
  readonly name = "mcp_install";
  readonly description =
    "Install a new MCP server (stdio command, or http/sse url) into this agent's " +
    "mcp.json. Requires explicit user confirmation before writing — stdio installs " +
    "authorize a persistent local command. Fails if `name` already exists (uninstall " +
    "or edit it manually instead of overwriting). Takes effect from the next " +
    "conversation turn — tell the user so.";
  readonly schema = ArgsSchema;

  constructor(
    private readonly mcp: McpService,
    @Optional()
    @Inject(MCP_CONFIRM_PORT)
    private readonly port?: McpConfirmPort,
  ) {}

  /** 查重 → 请求用户确认 → 确认后写入。返回 im_send 同范式 JSON（前端确认卡按 status 渲染终态）。 */
  async execute(args: Args, ctx: ToolContext): Promise<string> {
    const result = (status: string, message: string) =>
      JSON.stringify({ status, name: args.name, message });
    const existingServers = this.mcp.loadConfig()?.mcpServers ?? {};
    if (existingServers[args.name]) {
      return result(
        "error",
        `MCP 服务器 "${args.name}" 已存在，安装失败（如需变更请先 mcp_uninstall 或人工编辑）。`,
      );
    }
    if (!this.port) {
      return result("error", "当前环境不支持确认，未安装。");
    }

    const outcome = await this.port.confirmInstall(
      {
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        name: args.name,
        server: args.server,
      },
      ctx.signal,
    );
    if (outcome === "cancelled") {
      return result(
        "cancelled",
        `用户拒绝安装 MCP 服务器 "${args.name}"，未安装。`,
      );
    }
    if (outcome === "timeout") {
      return result("timeout", `确认超时，未安装 MCP 服务器 "${args.name}"。`);
    }
    if (outcome === "interrupted") {
      return result(
        "interrupted",
        `确认被中断，未安装 MCP 服务器 "${args.name}"。`,
      );
    }

    try {
      // 落盘前用 updateConfig 拿到的盘上最新配置再查重一次，防住「查重之后、
      // 用户确认这段等待期间」被其他写路径（人工编辑 / 并发安装）抢先占名。
      await this.mcp.updateConfig((config) => {
        if (config.mcpServers[args.name]) {
          throw new McpInstallDuplicate();
        }
        return {
          mcpServers: { ...config.mcpServers, [args.name]: args.server },
        };
      });
    } catch (err) {
      if (err instanceof McpInstallDuplicate) {
        return result(
          "error",
          `MCP 服务器 "${args.name}" 已存在，安装失败（如需变更请先 mcp_uninstall 或人工编辑）。`,
        );
      }
      throw err;
    }
    return result(
      "installed",
      `已安装 MCP 服务器 "${args.name}"。下一轮对话生效——请告知用户。`,
    );
  }
}
