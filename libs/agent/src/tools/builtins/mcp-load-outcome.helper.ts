import type { McpService } from "../../mcp/mcp.service";

/**
 * `mcp_install` / `mcp_enable` 落盘后（`updateConfig` 已触发 reload 立即重建
 * 运行态）按**实际加载结果**分流返回文案的共用逻辑——不能无条件说「已生效」，
 * 配置写入成功不等于连接成功（stdio 命令不存在 / http server 不可达等）。
 *
 * 用 `getLoadedToolNames` 按 `mcp__<name>__` 前缀统计**这一个 server** 实际
 * 加载到的工具数（而不是整个 Agent 的全部工具数——reload 会重建全部 server，
 * 只看这一个 server 的量才能诚实反映这次 install/enable 本身的结果）。
 *
 * @param mcp McpService 实例
 * @param cloudUserId 账号 ID
 * @param agentId Agent ID
 * @param serverName 刚 install/enable 的 server 名（mcp.json key）
 * @returns 该 server 实际加载到的工具数（0 = 配置已保存但连接失败/零工具）
 */
export function countLoadedToolsForServer(
  mcp: McpService,
  cloudUserId: string,
  agentId: string,
  serverName: string,
): number {
  const loaded = mcp.getLoadedToolNames(cloudUserId, agentId);
  if (!loaded) return 0;
  const prefix = `mcp__${serverName}__`;
  return [...loaded].filter((n) => n.startsWith(prefix)).length;
}

/**
 * 按加载结果生成诚实的返回文案：加载到 ≥1 个工具才说"已生效"；否则明确说
 * "配置已保存但连接失败/未加载到工具"，并指路 `mcp_list` 供模型自行核实、
 * 避免模型据此向用户报「已可用」但工具实际调不通的落差。
 *
 * @param loadedCount 该 server 实际加载到的工具数（见 {@link countLoadedToolsForServer}）
 * @param verb 动作描述（"安装" / "启用"），用于拼接文案
 */
export function describeLoadOutcome(
  loadedCount: number,
  verb: "安装" | "启用",
): string {
  if (loadedCount > 0) {
    return `已生效，加载了 ${loadedCount} 个工具，本轮对话内立即可用——请告知用户。`;
  }
  return (
    `配置已保存，但${verb}后未能连接成功或未加载到任何工具` +
    "（可用 mcp_list 查看最新状态）——请告知用户核实，不要说「已可用」。"
  );
}
