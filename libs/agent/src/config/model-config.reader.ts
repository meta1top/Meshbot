/**
 * 云端网关代理 apiKey 占位符——真实厂商 key 只在云端持有，云端模型配置的
 * 内存态坐标行 `api_key` 字段固定写这个值（见 server-agent 的
 * `CloudModelConfigProxyService`，读时实时代理、不落库）；真实 device token
 * 在请求时由 `llm.factory.ts` 的 `buildCloudFetch` 动态注入，不落地本地库。
 * 定义在 libs/agent（而非 server-agent）以便 write（代理服务）与
 * read（这里 + createChatModel 云模型判定 + MODEL_CONFIG_READ_PORT 实现的
 * isCloudModel 判定）三侧共用同一常量，避免漂移。
 */
export const CLOUD_GATEWAY_API_KEY_PLACEHOLDER = "__cloud__";

/**
 * 启用的模型凭证。由 `MODEL_CONFIG_READ_PORT`（server-agent 侧委托
 * `ModelConfigService` 合并视图实现）解析得到——不再直读 sqlite
 * `model_configs` 表，本地 local 行与云端读时代理的 cloud 行都能解析出。
 */
export interface ActiveModelConfig {
  providerType: string;
  model: string;
  /** 配置显示名——usage 观测的模型名快照来源（改名/删除后历史仍显示当时名称）。 */
  name: string;
  apiKey: string;
  baseUrl: string;
  /**
   * 是否为经云端网关代理的模型（`api_key` 列为占位符）。
   * true 时 createChatModel 需要动态注入 device token，缓存 key 也不能用
   * `apiKey` 字段本身（虽然它本就只是占位符，非真实 token）。
   */
  isCloudModel: boolean;
}
