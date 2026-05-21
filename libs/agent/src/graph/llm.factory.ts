import { initChatModel } from "langchain/chat_models/universal";
import type { ActiveModelConfig } from "../config/model-config.reader";

/**
 * 按模型凭证构造一个支持流式的 LangChain chat model。
 *
 * 用 `initChatModel` 动态加载对应供应商的集成包，按 `providerType` 路由。
 * `streaming: true` 让 `.stream()` 走 token 级增量输出。
 */
export async function createChatModel(config: ActiveModelConfig) {
  return initChatModel(config.model, {
    modelProvider: config.providerType,
    apiKey: config.apiKey,
    ...(config.baseUrl ? { configuration: { baseURL: config.baseUrl } } : {}),
    streaming: true,
  });
}
