/** 本地模型配置缓存更新事件（server-agent 进程内 → ws/events 信封转发前端）。 */
export const MODEL_CONFIG_EVENTS = {
  /** 云端模型配置变更（代理缓存已失效）——前端应重拉合并后的模型列表。 */
  updated: "model-config.updated",
} as const;

/** 模型配置更新事件负载。 */
export interface ModelConfigUpdatedEvent {
  cloudUserId: string;
}
