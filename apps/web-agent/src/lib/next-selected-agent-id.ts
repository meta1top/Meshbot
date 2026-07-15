/**
 * 删除 agent 后「当前选中 agent」应该落在哪：
 * - 被删的就是当前选中的 agent（`deletedId === currentId`）→ 切到 `remaining` 第一个
 *   （`remaining` 已经是删除后的剩余列表，不含 `deletedId`）；`remaining` 为空则返回 null。
 * - 删的是别的 agent（用户当前对话的 agent 完全没被动）→ **保持 `currentId` 不变**，
 *   不能因为删了一个无关 agent 就把用户正在对话的 agent 静默切走。
 *
 * 纯函数，供 `AgentEditorSheet` 的 `handleDelete` 调用，也便于脱离 React/atom 单独测试。
 */
export function nextSelectedAgentId(
  deletedId: string,
  currentId: string | null,
  remaining: ReadonlyArray<{ id: string }>,
): string | null {
  if (deletedId !== currentId) return currentId;
  return remaining[0]?.id ?? null;
}
