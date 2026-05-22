import { initChatModel } from "langchain/chat_models/universal";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
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
 * 按模型凭证构造一个支持流式的 LangChain chat model。
 *
 * 用 `initChatModel` 动态加载对应供应商的集成包，按 `providerType` 路由。
 * `streaming: true` 让 `.stream()` 走 token 级增量输出。
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
  })) as BaseChatModel;
}
