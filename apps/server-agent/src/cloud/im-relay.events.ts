import type {
  AgentRunControlForwarded,
  AgentRunStartForwarded,
  DeviceQueryForwarded,
} from "@meshbot/types";

/** im-relay 本地事件（server-agent 进程内 EventEmitter2）。 */
export const IM_RELAY_EVENTS = {
  connected: "im.relay.connected",
  /** 云端广播的 org 模型配置变更（失效信号）——sync 服务收到即全量重同步。 */
  modelConfigChanged: "im.relay.model_config_changed",
  /**
   * 云端广播的远程 Agent 注册表变更（失效信号）——EventsGateway 收到即下发浏览器
   * 重拉 `/api/remote-agents`（修「B 关掉允许远程后 A 的列表不消失」）。
   */
  agentRegistryChanged: "im.relay.agent_registry_changed",
  /** L2c：云端回流的设备查询响应（B→云→A），桥给 RemoteDeviceQueryService.settle。 */
  deviceQueryResponse: "im.relay.device_query_response",
  /** L2c：云端转发给本设备的入站查询请求（A→云→B），供 Task4 入站消费。 */
  deviceQueryRequest: "im.relay.device_query_request",
  /** L3：云端转发给本设备的入站远程 run 请求（A→云→B），供 Task4 入站消费。 */
  agentRunRequest: "im.relay.agent_run_request",
  /** L3：云端转发给本设备的入站运行控制指令（A→云→B），供 Task5 入站消费。 */
  agentRunControlInbound: "im.relay.agent_run_control",
  /** L3：云端回流的运行帧（B→云→A），桥给 RemoteRunService.onFrame。 */
  agentRunFrame: "im.relay.agent_run_frame",
  /** L3：云端回流的流终止通知（B→云→A），桥给 RemoteRunService.onEnd。 */
  agentRunEnd: "im.relay.agent_run_end",
} as const;

/** relay 重连成功事件负载。 */
export interface ImRelayConnectedEvent {
  cloudUserId: string;
}

/** 云端模型配置变更事件负载（失效信号，无明细）。 */
export interface ImRelayModelConfigChangedEvent {
  cloudUserId: string;
}

/** 云端远程 Agent 注册表变更事件负载（失效信号，无明细）。 */
export interface ImRelayAgentRegistryChangedEvent {
  cloudUserId: string;
}

/**
 * L2c：入站设备查询请求本地事件负载（云端转发，供本地执行方消费并回发响应）。
 *
 * @public-api Task 4（入站处理器）消费此事件负载类型；本任务只负责发出该事件。
 */
export interface ImRelayDeviceQueryRequestEvent {
  cloudUserId: string;
  forwarded: DeviceQueryForwarded;
}

/**
 * L3：入站远程 run 请求本地事件负载（云端转发，供本设备执行方消费并回流运行帧）。
 *
 * @public-api Task 4（入站处理器）消费此事件负载类型；本任务只负责发出该事件。
 */
export interface ImRelayAgentRunRequestEvent {
  cloudUserId: string;
  forwarded: AgentRunStartForwarded;
}

/**
 * L3：入站运行控制指令本地事件负载（云端转发，供本设备执行方消费并驱动 runner）。
 *
 * @public-api Task 5（入站处理器）消费此事件负载类型；本任务只负责发出该事件。
 */
export interface ImRelayAgentRunControlEvent {
  cloudUserId: string;
  forwarded: AgentRunControlForwarded;
}
