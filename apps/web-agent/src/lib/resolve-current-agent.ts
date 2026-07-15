/**
 * 首屏自动选中逻辑：`currentId` 为 null 或指向已不在列表中的 agent（被删除/未加载）时，
 * 回退到列表第一个；否则保持原值不变。`agents` 为空时返回 null（无可选 agent）。
 *
 * 纯函数，供 `AgentRail` 的 effect 调用，也便于脱离 React/atom 单独测试。
 */
export function resolveCurrentAgentId(
  agents: ReadonlyArray<{ id: string }>,
  currentId: string | null,
): string | null {
  if (agents.length === 0) return null;
  if (currentId != null && agents.some((a) => a.id === currentId)) {
    return currentId;
  }
  return agents[0].id;
}
