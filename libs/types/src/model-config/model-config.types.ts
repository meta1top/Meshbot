/**
 * 组织级模型配置 —— 跨域类型(云端 server-main 管理配置 + 本地轨 Agent 消费)。
 *
 * `OrgModelConfigInput` / `OrgModelConfigView` 是云端管理侧读写形状；
 * `AgentModelConfig` 是下发给本地 Agent 的"可见列表"视图——**不含任何厂商敏感字段**
 * (apiKey / baseUrl / providerType / 真实 model)。厂商调用改由云端网关持有
 * `resolveDecrypted` 内部解密，本地 Agent 只拿 id 做调用引用，见「云端模型网关」。
 */

/** 新建/更新组织模型配置的输入。 */
export interface OrgModelConfigInput {
  name: string;
  providerType: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number;
  enabled?: boolean;
}

/** 组织模型配置管理视图(apiKey 打码)。 */
export interface OrgModelConfigView {
  id: string;
  orgId: string;
  name: string;
  providerType: string;
  model: string;
  apiKeyMasked: string;
  baseUrl: string;
  contextWindow: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** 下发给 Agent 的模型配置可见列表(仅 enabled 项，无厂商敏感字段)。 */
export interface AgentModelConfig {
  id: string;
  name: string;
  contextWindow: number | null;
  enabled: boolean;
}
