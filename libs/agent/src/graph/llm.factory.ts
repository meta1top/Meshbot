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
 * 调试用 callback：默认打**单行摘要**（model、prompt 末条预览、token 用量、finish_reason）。
 * 出错时打详细错误。如需全量原始 LLMResult（诊断 usage 缺失等问题）设
 * `MESHBOT_LLM_DEBUG=verbose`；设 `=0` 关闭。
 */
class LlmDebugCallbackHandler extends BaseCallbackHandler {
  name = "LlmDebugCallback";

  private readonly verbose = process.env.MESHBOT_LLM_DEBUG === "verbose";

  handleChatModelStart(llm: Serialized, messages: BaseMessage[][]): void {
    if (!this.verbose) {
      // 单行摘要：最后一条消息的 role + content 前 60 字
      const last = messages[messages.length - 1]?.slice(-1)[0];
      const role = last?._getType?.() ?? "?";
      const content =
        typeof last?.content === "string" ? last.content.slice(0, 60) : "";
      console.log(`[LLM start] ${role}="${content}"`);
      return;
    }
    const name = (llm as { name?: string }).name ?? "<unknown>";
    console.log(
      `[LLM start chat] ${name} messages=${JSON.stringify(messages).slice(0, 1000)}`,
    );
  }

  handleLLMEnd(output: LLMResult): void {
    if (!this.verbose) {
      // 单行摘要：text 前 60 字 + token 用量
      const g = output.generations[0]?.[0];
      const text =
        typeof g?.text === "string" ? g.text.slice(0, 60) : "<non-string>";
      const meta = (
        g as {
          message?: {
            usage_metadata?: {
              input_tokens?: number;
              output_tokens?: number;
              total_tokens?: number;
            };
          };
        }
      )?.message?.usage_metadata;
      const usage = meta
        ? `in=${meta.input_tokens ?? "?"} out=${meta.output_tokens ?? "?"} total=${meta.total_tokens ?? "?"}`
        : "no usage_metadata";
      const finish = (g as { generationInfo?: { finish_reason?: string } })
        ?.generationInfo?.finish_reason;
      console.log(`[LLM end] ${usage} finish=${finish ?? "?"} text="${text}"`);
      return;
    }
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
  const configuration: Record<string, unknown> = {};
  if (config.baseUrl) configuration.baseURL = config.baseUrl;
  // 临时验证：deepseek thinking 模式要求每条 assistant 消息带 reasoning_content，
  // 但 @langchain/openai 序列化 message 时不会回写。拦截 fetch 给 assistant
  // 消息补一个空字段，验证占位能否绕过 deepseek 服务端校验。
  if (config.providerType === "deepseek") {
    configuration.fetch = patchedFetchForDeepseek(globalThis.fetch);
  }
  return (await initChatModel(config.model, {
    modelProvider:
      PROVIDER_MODEL_NAME[config.providerType] ?? config.providerType,
    apiKey: config.apiKey,
    ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
    streaming: true,
    ...(debugCallback ? { callbacks: [debugCallback] } : {}),
  })) as BaseChatModel;
}

/**
 * Wrap fetch：检测 POST /chat/completions JSON body，给 role=assistant 且
 * 缺 reasoning_content 的消息补一个空 reasoning_content。临时验证用，确认
 * 占位能否过 deepseek thinking 校验后再抽架构。
 */
function patchedFetchForDeepseek(base: typeof fetch): typeof fetch {
  return async function patchedFetch(input, init) {
    if (!init?.body || typeof init.body !== "string") {
      return base(input, init);
    }
    let body: { messages?: Array<Record<string, unknown>> };
    try {
      body = JSON.parse(init.body);
    } catch {
      return base(input, init);
    }
    if (!Array.isArray(body.messages)) {
      return base(init === undefined ? input : input, init);
    }
    let patched = false;
    for (const msg of body.messages) {
      if (msg.role === "assistant" && msg.reasoning_content === undefined) {
        msg.reasoning_content = "";
        patched = true;
      }
    }
    if (!patched) {
      return base(input, init);
    }
    console.log(
      `[deepseek-patch] injected reasoning_content="" into ${body.messages.filter((m) => m.role === "assistant").length} assistant message(s)`,
    );
    return base(input, { ...init, body: JSON.stringify(body) });
  };
}
