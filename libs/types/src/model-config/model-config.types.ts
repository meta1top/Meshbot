/**
 * 组织级模型配置 —— 跨域类型(云端 server-main 管理配置 + 本地轨 Agent 消费)。
 *
 * `OrgModelConfigInput` / `OrgModelConfigView` 是云端管理侧读写形状；
 * `AgentModelConfig` 是下发给本地 Agent 的解密后视图(本地轨消费，见 Task 13)。
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

/** 下发给 Agent 的模型配置(含明文 apiKey，仅 enabled 项)。 */
export interface AgentModelConfig {
  id: string;
  providerType: string;
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  contextWindow: number;
  enabled: boolean;
}
