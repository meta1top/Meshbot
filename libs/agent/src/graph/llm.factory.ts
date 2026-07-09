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
  options?: {
    /** 覆盖 streaming，title / one-shot 场景设 false 跳过 stream 开销。 */
    streaming?: boolean;
    /**
     * 透传到 OpenAI client 的额外参数。deepseek thinking 模型用
     * `{ thinking: { type: "disabled" } }` 关思考；其他 provider 按各自约定。
     */
    modelKwargs?: Record<string, unknown>;
    /**
     * 云网关模型（`config.isCloudModel`）取当前 device token 的回调。
     * 每次请求都会重新调用，token 轮换无需重建 client；不传时云模型请求
     * 会带空 Bearer（server-agent 侧接线见后续任务）。
     */
    cloudTokenProvider?: () => string | null;
  },
): Promise<BaseChatModel> {
  const configuration: Record<string, unknown> = {};
  if (config.baseUrl) configuration.baseURL = config.baseUrl;
  // 临时验证：deepseek thinking 模式要求每条 assistant 消息带 reasoning_content，
  // 但 @langchain/openai 序列化 message 时不会回写。拦截 fetch 给 assistant
  // 消息补一个空字段，验证占位能否绕过 deepseek 服务端校验。
  if (config.providerType === "deepseek") {
    configuration.fetch = patchedFetchForDeepseek(globalThis.fetch);
  }
  // 云网关模型：apiKey 落地的是占位符（真实厂商 key 只在云端持有），client
  // 用占位 key 建一次即可；每次请求靠 fetch 包装把 Authorization 换成当前
  // device token，避免把易失效的 token 提前烘进 client 实例。
  if (config.isCloudModel) {
    configuration.fetch = buildCloudFetch(
      globalThis.fetch,
      options?.cloudTokenProvider ?? (() => null),
    );
  }
  return (await initChatModel(config.model, {
    modelProvider:
      PROVIDER_MODEL_NAME[config.providerType] ?? config.providerType,
    apiKey: config.apiKey,
    ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
    streaming: options?.streaming ?? true,
    ...(options?.modelKwargs ? { modelKwargs: options.modelKwargs } : {}),
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

/**
 * 云网关 fetch 包装：每次请求前把 `Authorization` 覆盖为
 * `Bearer <tokenProvider()>`。client 建好后 apiKey 固定是占位符
 * （`__cloud__`），真实 device token 只在这里、每次请求现取现用——token
 * 轮换（重新登录换发新 token）时无需重建/重新缓存 client。
 *
 * clone `init.headers` 再覆盖，不直接改调用方传入的 headers 引用。兼容两种
 * 形状：普通 record（测试 / 多数手写调用）与原生 `Headers` 实例——
 * `@langchain/openai` 底层用的 `openai` SDK 组装请求头时用的就是真实
 * `Headers` 对象，对它做 `{...headers}` 浅展开拿不到任何字段（`Headers`
 * 不暴露可枚举自有属性），会把 User-Agent / Accept 等头静默丢光。
 * 导出以便单测直接验证覆盖行为。
 */
export function buildCloudFetch(
  base: typeof fetch,
  tokenProvider: () => string | null,
): typeof fetch {
  return async function cloudFetch(input, init) {
    const authorization = `Bearer ${tokenProvider() ?? ""}`;
    const rawHeaders = init?.headers;
    if (rawHeaders instanceof Headers) {
      const headers = new Headers(rawHeaders);
      headers.set("Authorization", authorization);
      return base(input, { ...init, headers });
    }
    const headers = {
      ...(rawHeaders as Record<string, string> | undefined),
      Authorization: authorization,
    };
    return base(input, { ...init, headers });
  };
}
