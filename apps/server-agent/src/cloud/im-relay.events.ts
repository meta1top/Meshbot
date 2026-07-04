/** im-relay 本地事件（server-agent 进程内 EventEmitter2）。 */
export const IM_RELAY_EVENTS = {
  connected: "im.relay.connected",
} as const;

/** relay 重连成功事件负载。 */
export interface ImRelayConnectedEvent {
  cloudUserId: string;
}
