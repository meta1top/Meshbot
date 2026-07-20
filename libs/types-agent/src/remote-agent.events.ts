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
  /**
   * Agent 级观察通道（T18）：远程 Agent 的会话生命周期镜像（session.created /
   * deleted / renamed / status_changed）下发本机浏览器的专属信封 type。
   *
   * **不复用**本地 `SESSION_LIFECYCLE_EVENTS.*` 等事件名——那条总线上挂着
   * `AgentWatchMirrorService`（会把收到的事件当本机事件再镜像出去，形成
   * 回环）与 `EventsGateway` 的本地下发路径（浏览器会把远程会话误插进
   * **本机**列表）。故这批镜像帧改走这个专属信封，携带**云端 agentId**，
   * 浏览器按 agentId 分流到对应远程 Agent 的观察视图——与
   * `REMOTE_SHADOW_FRAME_EVENT` 不复用原始 `SESSION_WS_EVENTS.*` 名是同一个
   * 理由（见其 JSDoc）。
   */
  sessionEvent: "remote-agent.session_event",
} as const;

/** 远程 Agent 注册表变更事件负载（失效信号，无明细）。 */
export interface RemoteAgentRegistryChangedEvent {
  cloudUserId: string;
}

/**
 * Agent 级观察通道：远程 Agent 会话生命周期镜像信封负载。
 *
 * `agentId` 是**云端** Agent id（不是本地 agentId）——前端据此判定该帧属于
 * 哪个远程 Agent 的观察视图；`event` / `payload` 原样透传对端
 * `SESSION_LIFECYCLE_EVENTS.*`（或未来的 `SESSION_STATUS_EVENTS.changed`）的
 * 事件名与 payload，不在此处重新解析（`RemoteWatchService` 只做信封搬运）。
 */
export interface RemoteAgentSessionEventPayload {
  agentId: string;
  event: string;
  payload: unknown;
}
