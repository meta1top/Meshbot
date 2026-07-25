import type { McpServerConfig } from "../mcp/mcp.schema";

/**
 * MCP_CONFIRM_PORT —— libs/agent → server-agent 解耦端口（mcp_install 的 HITL 确认）。
 *
 * 安装一个 MCP server（尤其 stdio）等于授权一个常驻本地命令且写入持久化配置，
 * 因此必须经用户确认。server-agent 实现挂现有 ConfirmationService 弹卡等待；
 * 无 server-agent 环境（纯 lib 测试）可不注入（@Optional）。
 */
export const MCP_CONFIRM_PORT = Symbol("MCP_CONFIRM_PORT");

/** mcp_install 的 HITL 确认端口：server-agent 实现弹卡等待用户决定。fail-safe：超时/中断视为不安装。 */
export interface McpConfirmPort {
  confirmInstall(
    params: {
      sessionId: string;
      toolCallId: string;
      name: string;
      server: McpServerConfig;
    },
    signal: AbortSignal,
  ): Promise<"confirmed" | "cancelled" | "timeout" | "interrupted">;
}
