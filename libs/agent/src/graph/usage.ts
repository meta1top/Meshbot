import type { AIMessageChunk } from "@langchain/core/messages";

/**
 * LLM token 用量的提取与归一。
 *
 * 从 graph-runner.service.ts 抽出为独立模块：ModelResolver.summarize() 也要记账，
 * 而 graph-runner 本身 import 了 ModelResolver——若从 graph-runner 导出会形成
 * 循环引用。放这里两边都只依赖纯函数，无环。
 */

export interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * 从累计 AIMessageChunk 兜底提取 token 用量。
 *
 * 取数优先级：
 * 1. `usage_metadata` —— LangChain 0.3 跨厂商标准字段（@langchain/openai 0.6+ 等）
 * 2. `response_metadata.usage` —— OpenAI 兼容路径原始字段（deepseek、第三方代理常用）
 * 3. `response_metadata.tokenUsage` —— LangChain 旧版 camelCase 字段
 * 4. `additional_kwargs.usage` —— 个别集成包的位置
 *
 * 全部缺失返回 null。
 */
export function extractUsage(
  msg: AIMessageChunk | undefined,
): ExtractedUsage | null {
  if (!msg) return null;

  // 1) LangChain 标准 usage_metadata
  const meta = msg.usage_metadata;
  if (meta && (meta.input_tokens || meta.output_tokens || meta.total_tokens)) {
    return {
      inputTokens: meta.input_tokens ?? 0,
      outputTokens: meta.output_tokens ?? 0,
      totalTokens: meta.total_tokens ?? 0,
      cacheReadTokens: meta.input_token_details?.cache_read ?? 0,
      cacheCreationTokens: meta.input_token_details?.cache_creation ?? 0,
      reasoningTokens: meta.output_token_details?.reasoning ?? 0,
    };
  }

  const rawMsg = msg as unknown as {
    response_metadata?: Record<string, unknown>;
    additional_kwargs?: Record<string, unknown>;
  };

  // 2) response_metadata.usage —— OpenAI 兼容字段（snake_case）
  const respUsage = rawMsg.response_metadata?.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
        // deepseek 私有扩展
        prompt_cache_hit_tokens?: number;
      }
    | undefined;
  if (
    respUsage &&
    (respUsage.prompt_tokens ||
      respUsage.completion_tokens ||
      respUsage.total_tokens)
  ) {
    const inputTokens = respUsage.prompt_tokens ?? 0;
    const outputTokens = respUsage.completion_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: respUsage.total_tokens ?? inputTokens + outputTokens,
      cacheReadTokens:
        respUsage.prompt_tokens_details?.cached_tokens ??
        respUsage.prompt_cache_hit_tokens ??
        0,
      cacheCreationTokens: 0,
      reasoningTokens:
        respUsage.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  }

  // 3) response_metadata.tokenUsage —— LangChain 旧式 camelCase
  const tokenUsage = rawMsg.response_metadata?.tokenUsage as
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      }
    | undefined;
  if (tokenUsage && (tokenUsage.promptTokens || tokenUsage.completionTokens)) {
    const inputTokens = tokenUsage.promptTokens ?? 0;
    const outputTokens = tokenUsage.completionTokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: tokenUsage.totalTokens ?? inputTokens + outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
  }

  // 4) additional_kwargs.usage
  const altUsage = rawMsg.additional_kwargs?.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined;
  if (altUsage && (altUsage.prompt_tokens || altUsage.completion_tokens)) {
    const inputTokens = altUsage.prompt_tokens ?? 0;
    const outputTokens = altUsage.completion_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: altUsage.total_tokens ?? inputTokens + outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
  }

  return null;
}
