/**
 * 已知模型的静态元数据真值表。
 *
 * 单一来源：后端在创建 / 更新 ModelConfig 时按 `model` 名查这里得到 contextWindow，
 * 解析后写进 `model_configs.context_window` 列固化。前端只读 DB 返回值，
 * 不直接 import 本表（保持前端零模型知识）。
 *
 * 维护流程：
 * - 出新模型 → 在 MODEL_SPECS 加一行 → 走正常 PR
 * - 用户自配 / 私有模型 → 在 ModelConfig 表单填 contextWindow 字段覆盖
 * - 仓库内置值变化时，DB 里已有行保留旧值（"配置时快照"语义）；要全局刷新
 *   走单独的 admin 接口（v1 不做）
 */

export interface ModelSpec {
  /** 模型的上下文窗口（token 数），用于前端进度环分母与未来的上下文压缩判定。 */
  contextWindow: number;
}

/**
 * 各 provider 已知模型的 spec。key 为 model 名（与 ModelConfig.model 对应）。
 *
 * **来源说明**：以 provider 公开文档为准；本仓库不向 provider API 实时查询，
 * 数据有滞后；用户碰到差异时可以走 ModelConfig 表单覆盖。
 */
export const MODEL_SPECS: Readonly<Record<string, ModelSpec>> = {
  // OpenAI（chat completions 口径）
  "gpt-4o": { contextWindow: 128_000 },
  "gpt-4o-mini": { contextWindow: 128_000 },
  "gpt-4-turbo": { contextWindow: 128_000 },
  "gpt-4.1": { contextWindow: 1_000_000 },
  // GPT-5 系（API 口径 400k；有变更时用户可表单覆盖）
  "gpt-5.2": { contextWindow: 400_000 },
  "gpt-5.2-pro": { contextWindow: 400_000 },

  // Anthropic（Messages API 口径 200k）
  "claude-opus-4-8": { contextWindow: 200_000 },
  "claude-sonnet-5": { contextWindow: 200_000 },
  "claude-opus-4-7": { contextWindow: 200_000 },
  "claude-sonnet-4-6": { contextWindow: 200_000 },
  "claude-haiku-4-5": { contextWindow: 200_000 },
  // 旧版命名（兼容）
  "claude-3-5-sonnet": { contextWindow: 200_000 },
  "claude-3-5-sonnet-20241022": { contextWindow: 200_000 },
  "claude-3-opus": { contextWindow: 200_000 },
  "claude-3-haiku": { contextWindow: 200_000 },

  // Google
  "gemini-2.5-pro": { contextWindow: 2_000_000 },
  "gemini-2.5-flash": { contextWindow: 1_000_000 },
  "gemini-1.5-pro": { contextWindow: 2_000_000 },
  "gemini-1.5-flash": { contextWindow: 1_000_000 },
  "gemini-2.0-flash": { contextWindow: 1_000_000 },

  // DeepSeek
  "deepseek-v4-pro": { contextWindow: 1_000_000 },
  "deepseek-chat": { contextWindow: 64_000 },
  "deepseek-reasoner": { contextWindow: 64_000 },

  // Qwen3 · Ollama tag 形态（Ollama 默认 num_ctx 40960；模型原生 32k、
  // YaRN 可扩 128k——按 Ollama 实际默认给值，需更大时用户覆盖或改 modelfile）
  "qwen3:8b": { contextWindow: 40_960 },
  "qwen3:14b": { contextWindow: 40_960 },
  "qwen3:32b": { contextWindow: 40_960 },
  "qwen3:30b-a3b": { contextWindow: 40_960 },
  // Qwen3 · 云端 API 形态
  "qwen3-max": { contextWindow: 262_144 },
};

/** 未列出模型的兜底窗口大小（足够大多数主流模型，且不会让 UI 进度环失真到太离谱）。 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** 按 model 名取 spec；未列出返 undefined。供后端解析逻辑用。 */
export function getModelSpec(model: string): ModelSpec | undefined {
  return MODEL_SPECS[model];
}

/**
 * 解析最终 contextWindow，优先级：
 *   用户覆盖值 > 仓库内置 spec > FALLBACK
 *
 * Service 层在 create / update ModelConfig 时调一次，把结果写进 DB。
 */
export function resolveContextWindow(
  model: string,
  userOverride?: number | null,
): number {
  if (userOverride && userOverride > 0) return userOverride;
  return MODEL_SPECS[model]?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
}
