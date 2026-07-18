/**
 * 远程 Agent 注册表变更事件（server-agent 进程内 → ws/events 信封转发前端）。
 *
 * 链路：某台设备改本地 Agent 的「允许远程」开关 → 推云端对账 → server-main
 * 广播 `im.agent_registry_changed` → 本机 relay 收到并桥到进程内 → EventsGateway
 * 包信封下发浏览器 → 前端 invalidate `remote-agents` 查询。
 */
export const REMOTE_AGENT_EVENTS = {
  /** 同账号任一设备的远程 Agent 注册表有变（失效信号，无明细）。 */
  registryChanged: "remote-agent.registry_changed",
} as const;

/** 远程 Agent 注册表变更事件负载（失效信号，无明细）。 */
export interface RemoteAgentRegistryChangedEvent {
  cloudUserId: string;
}
