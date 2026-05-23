/**
 * 常见模型的上下文窗口（token 数）。
 *
 * 用于 ChatInput 右下角 token usage 进度环的分母。本期前端 hardcode；
 * 以后做上下文压缩时再正式引入 ModelConfig.contextWindow 字段。
 *
 * 未列出的 model 名 → fallback 128_000。
 */
const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4.1": 1_000_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-haiku": 200_000,
  "deepseek-chat": 64_000,
  "deepseek-reasoner": 64_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
};

const FALLBACK = 128_000;

/** 返回 model 名对应的上下文窗口大小（未列出则返回 fallback）。 */
export function getModelContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOW[model] ?? FALLBACK;
}
