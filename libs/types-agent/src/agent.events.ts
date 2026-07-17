/**
 * 本地 Agent 变更事件（server-agent 进程内 EventEmitter2）：
 * Agent CRUD（create/update/delete/duplicate）成功后触发，供
 * `AgentCloudSyncService` 监听并把 remote_enabled Agent 全量推送云端对账。
 */
export const AGENT_EVENTS = {
  changed: "agent.changed",
} as const;

/** agent.changed 事件负载。 */
export interface AgentChangedEvent {
  cloudUserId: string;
}
