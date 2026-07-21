/**
 * 本地 Agent 变更事件（server-agent 进程内 EventEmitter2）：
 * Agent CRUD（create/update/delete/duplicate）成功后触发。
 *
 * 发射点在 `AgentService`（create/update/removeWithData）而非 Controller——
 * 这样「表单改名」（`AgentController.update` REST）与「`rename_agent` 工具改名」
 * （`AGENT_RENAME_PORT` → `AgentService.update`）两条路径自动共享同一个事件，
 * 不会再出现某条路径静默不通知的洞。
 *
 * 两个消费方：
 * - `AgentCloudSyncService`：把 remote_enabled Agent 全量推送云端对账；
 * - `EventsGateway`：包成全局信封下发浏览器，前端 invalidate `["agents"]`，
 *   侧栏 Agent 列表与会话标题栏实时跟着改名/增删刷新（跨窗口、跨端）。
 */
export const AGENT_EVENTS = {
  changed: "agent.changed",
} as const;

/** agent.changed 事件负载。 */
export interface AgentChangedEvent {
  cloudUserId: string;
  /** 变更的 Agent id；删除后为已删除的 id。缺省表示「不确定/全量失效」。 */
  agentId?: string;
}
