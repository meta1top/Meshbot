import type { SessionSummary } from "@meshbot/types-agent";

/**
 * 按当前选中 Agent 过滤会话列表（侧栏用）。
 *
 * `currentAgentId` 为 null（首屏 Agent 尚未解析完成的短暂窗口）时不过滤，
 * 原样返回全部——避免在 Agent 列表加载完成前把侧栏闪成空列表；一旦
 * `currentAgentId` 落定，过滤立即生效。纯函数，脱离 React/atom 单独测试。
 */
export function filterSessionsByAgent(
  sessions: readonly SessionSummary[],
  currentAgentId: string | null,
): SessionSummary[] {
  if (currentAgentId == null) return [...sessions];
  return sessions.filter((s) => s.agentId === currentAgentId);
}
