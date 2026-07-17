import type { ModelConfigInput } from "@meshbot/types-agent";
import type { ModelConfig, ModelConfigUpdate } from "@/rest/model-config";

/** 表单收集值（contextWindow 以字符串收，提交时转 number）。 */
export interface ModelConfigFormValues {
  name?: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  contextWindow?: string;
}

/** 供 payload 构造用的 provider 最小形状。 */
export interface ProviderLike {
  type: string;
  name: string;
}

/** 表单值 → 后端入参：空 name 用 `provider - model` 兜底，空串字段归 undefined。 */
export function buildModelConfigPayload(
  values: ModelConfigFormValues,
  provider: ProviderLike,
): ModelConfigInput {
  return {
    providerType: provider.type,
    name: values.name?.trim() || `${provider.name} - ${values.model}`,
    model: values.model,
    apiKey: values.apiKey,
    baseUrl: values.baseUrl?.trim() || undefined,
    contextWindow: values.contextWindow
      ? Number(values.contextWindow)
      : undefined,
  };
}

/** 是否为本地可编辑配置（云端条目只读）。 */
export function isLocalConfig(config: Pick<ModelConfig, "source">): boolean {
  return config.source === "local";
}

/**
 * 编辑态表单 payload → PATCH body：`apiKey` 留空表示不更改当前密钥，需从
 * patch 里剔除（否则会把已存密钥误清空）；其余字段直传。
 */
export function buildUpdatePatch(payload: ModelConfigInput): ModelConfigUpdate {
  const patch: ModelConfigUpdate = {
    name: payload.name,
    model: payload.model,
    baseUrl: payload.baseUrl,
    contextWindow: payload.contextWindow,
  };
  if (payload.apiKey) patch.apiKey = payload.apiKey;
  return patch;
}
