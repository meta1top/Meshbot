import type { DeviceQueryForwarded } from "@meshbot/types";

/** im-relay 本地事件（server-agent 进程内 EventEmitter2）。 */
export const IM_RELAY_EVENTS = {
  connected: "im.relay.connected",
  /** L2c：云端回流的设备查询响应（B→云→A），桥给 RemoteDeviceQueryService.settle。 */
  deviceQueryResponse: "im.relay.device_query_response",
  /** L2c：云端转发给本设备的入站查询请求（A→云→B），供 Task4 入站消费。 */
  deviceQueryRequest: "im.relay.device_query_request",
} as const;

/** relay 重连成功事件负载。 */
export interface ImRelayConnectedEvent {
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
