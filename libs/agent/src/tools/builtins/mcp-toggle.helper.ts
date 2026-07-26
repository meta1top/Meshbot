import type { McpService } from "../../mcp/mcp.service";

/** mcp_enable / mcp_disable 共用开关结果。 */
export type McpToggleResult = "toggled" | "already" | "not-found";

/** 目标态已达成 / server 不存在时用来短路 `updateConfig` mutator 的哨兵异常。 */
class McpToggleNotFound extends Error {}
class McpToggleNoop extends Error {}

/**
 * mcp_enable / mcp_disable 共用的开关逻辑：
 * - 不存在该 server → 不落盘、不 teardown，返回 "not-found"
 * - 已是目标态 → 幂等 no-op，同样不落盘、不 teardown（避免打断正在跑的 MCP 连接）
 * - 否则翻转 `enabled` 并落盘（`McpService.updateConfig` 自动 teardown 当前 Agent 运行态）
 *
 * 判断用的是 `updateConfig` mutator 拿到的、盘上最新配置——不是工具层缓存。
 */
export async function toggleMcpServerEnabled(
  mcp: McpService,
  name: string,
  target: boolean,
): Promise<McpToggleResult> {
  try {
    await mcp.updateConfig((config) => {
      const server = config.mcpServers[name];
      if (!server) {
        throw new McpToggleNotFound();
      }
      const current = server.enabled !== false;
      if (current === target) {
        throw new McpToggleNoop();
      }
      return {
        mcpServers: {
          ...config.mcpServers,
          [name]: { ...server, enabled: target },
        },
      };
    });
    return "toggled";
  } catch (err) {
    if (err instanceof McpToggleNotFound) return "not-found";
    if (err instanceof McpToggleNoop) return "already";
    throw err;
  }
}
