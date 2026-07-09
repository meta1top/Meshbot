import { PROVIDERS, type ProviderDef } from "@meshbot/web-common";

const MAX_MODEL_NAME_LENGTH = 64;

/** 从 PROVIDERS 预设清单按 type 查供应商定义;未命中返回 undefined。 */
export function resolveProviderPreset(
  providerType: string,
): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.type === providerType);
}

/**
 * 计算模型配置名:name 去空格后非空则原样返回;
 * 空则按「供应商名 - 模型」自动生成,供应商未命中预设时用 providerType 作标签。
 */
export function deriveModelName(input: {
  name?: string;
  providerType: string;
  model: string;
}): string {
  const trimmed = input.name?.trim();
  if (trimmed) {
    return trimmed;
  }
  const label =
    resolveProviderPreset(input.providerType)?.name ?? input.providerType;
  return `${label} - ${input.model}`.slice(0, MAX_MODEL_NAME_LENGTH);
}
