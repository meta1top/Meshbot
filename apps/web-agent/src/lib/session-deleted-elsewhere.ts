import type { SessionListEvent } from "@meshbot/web-common/session/session-list-events";
import type { ActiveAssistantSession } from "@/atoms/active-session";

/**
 * 判断一条会话生命周期事件是否命中「用户正打开的会话被删除」——命中即代表
 * 主内容区正显示一个已经不存在的会话，必须给出明确响应（真机验收缺陷：删除
 * 会话后侧栏行消失了，主内容区却还在显示已删除的对话）。
 *
 * 从 `use-global-events.ts` 的分发逻辑里抽出来的纯判定，脱离 jotai/socket
 * 单测，四层短路（顺序即优先级）：
 * 1. 不是 `deleted` 事件 → 不命中（created/renamed/status_changed 与此无关）。
 * 2. 当前没有打开任何会话（起手台空态）→ 不命中。
 * 3. 事件的 `sessionId` 与当前打开的不是同一个 → 不命中。
 * 4. `scope: "local"`（本机会话）：`active.remoteAgentId` 必须为 `null`（不能
 *    是正在看的远程会话），且这条会话不在本设备「正主动删除中」的宽限集合里
 *    ——命中即为自己点删除触发的 ws 回声，不重复提示（见
 *    `selfDeletingSessionIdsAtom` 文档）。
 *    `scope: { agentId }`（远程会话镜像）：`active.remoteAgentId` 必须等于
 *    该 agentId——远程会话在本应用没有删除入口，不需要自删抑制。
 */
export function isActiveSessionDeletedByEvent(params: {
  evt: SessionListEvent;
  scope: "local" | { agentId: string };
  active: ActiveAssistantSession | null;
  selfDeletingIds?: ReadonlySet<string>;
}): boolean {
  const { evt, scope, active, selfDeletingIds } = params;
  if (evt.type !== "deleted") return false;
  if (!active) return false;
  if (active.id !== evt.sessionId) return false;
  if (scope === "local") {
    if (active.remoteAgentId !== null) return false;
    if (selfDeletingIds?.has(evt.sessionId)) return false;
    return true;
  }
  return active.remoteAgentId === scope.agentId;
}
