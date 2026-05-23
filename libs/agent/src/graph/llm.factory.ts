import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";
import { initChatModel } from "langchain/chat_models/universal";
import type { ActiveModelConfig } from "../config/model-config.reader";

/**
 * PROVIDERS type → initChatModel 期望的 modelProvider 名。
 *
 * `google` 在 LangChain 中对应 `google-genai`；
 * `openai-compatible` 复用 `openai`（通过 baseUrl 路由）。
 */
const PROVIDER_MODEL_NAME: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google-genai",
  deepseek: "deepseek",
  ollama: "ollama",
  "openai-compatible": "openai",
};

/**
 * 调试用 callback：把每次 LLM 调用的 prompt 与原始 LLMResult（含 llmOutput.tokenUsage
 * 等供应商原文）打到控制台，便于诊断 usage 缺失等问题。设环境变量
 * MESHBOT_LLM_DEBUG=0 可关闭。
 */
class LlmDebugCallbackHandler extends BaseCallbackHandler {
  name = "LlmDebugCallback";

  handleLLMStart(llm: Serialized, prompts: string[]): void {
    const name = (llm as { name?: string }).name ?? "<unknown>";
    console.log(
      `[LLM start] ${name} prompts=${JSON.stringify(prompts).slice(0, 500)}`,
    );
  }

  handleChatModelStart(llm: Serialized, messages: BaseMessage[][]): void {
    const name = (llm as { name?: string }).name ?? "<unknown>";
    console.log(
      `[LLM start chat] ${name} messages=${JSON.stringify(messages).slice(0, 1000)}`,
    );
  }

  handleLLMEnd(output: LLMResult): void {
    console.log(
      "[LLM end] LLMResult=",
      JSON.stringify(
        {
          generations: output.generations.map((row) =>
            row.map((g) => {
              const generic = g as {
                generationInfo?: unknown;
                message?: {
                  usage_metadata?: unknown;
                  response_metadata?: unknown;
                  additional_kwargs?: unknown;
                  content?: unknown;
                };
              };
              return {
                text_preview:
                  typeof g.text === "string" ? g.text.slice(0, 100) : g.text,
                generationInfo: generic.generationInfo,
                message_usage_metadata: generic.message?.usage_metadata,
                message_response_metadata: generic.message?.response_metadata,
                message_additional_kwargs: generic.message?.additional_kwargs,
              };
            }),
          ),
          llmOutput: output.llmOutput,
        },
        null,
        2,
      ),
    );
  }

  handleLLMError(err: Error): void {
    console.error("[LLM error]", err);
  }
}

const debugCallback =
  process.env.MESHBOT_LLM_DEBUG === "0"
    ? undefined
    : new LlmDebugCallbackHandler();

/**
 * 按模型凭证构造一个支持流式的 LangChain chat model。
 *
 * 用 `initChatModel` 动态加载对应供应商的集成包，按 `providerType` 路由。
 * `streaming: true` 让 `.stream()` 走 token 级增量输出。
 * 默认挂一个 debug callback 把 prompt / 原始 LLMResult 打到控制台，便于诊断
 * usage 缺失等问题；设 `MESHBOT_LLM_DEBUG=0` 关掉。
 */
export async function createChatModel(
  config: ActiveModelConfig,
): Promise<BaseChatModel> {
  return (await initChatModel(config.model, {
    modelProvider:
      PROVIDER_MODEL_NAME[config.providerType] ?? config.providerType,
    apiKey: config.apiKey,
    ...(config.baseUrl ? { configuration: { baseURL: config.baseUrl } } : {}),
    streaming: true,
    ...(debugCallback ? { callbacks: [debugCallback] } : {}),
  })) as BaseChatModel;
}
