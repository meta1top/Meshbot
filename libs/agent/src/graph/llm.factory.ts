import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";
import { initChatModel } from "langchain/chat_models/universal";
import type { ActiveModelConfig } from "../config/model-config.reader";

/**
 * 本地轨 providerType → initChatModel 期望的 modelProvider 名。
 *
 * 本地轨只经云网关取模型：`CloudModelConfigProxyService` 的 `toGatewayRow` 把云端
 * 下发行的 providerType 固定写成 `openai-compatible`，真实厂商（anthropic /
 * google-genai / ollama / deepseek）的调用发生在 server-main 的 model-gateway。
 * 因此这里只需支持 OpenAI 兼容协议一种。
 */
const PROVIDER_MODEL_NAME: Record<string, string> = {
  openai: "openai",
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
     * 云网关模型（`config.isCloudModel`）取当前 device token 的回调。
     * 每次请求都会重新调用，token 轮换无需重建 client；不传时云模型请求
     * 会带空 Bearer。
     */
    cloudTokenProvider?: () => string | null;
  },
): Promise<BaseChatModel> {
  // 白名单守卫必须显式抛错：hoisted 模式下厂商包仍物理存在于根 node_modules
  // （server-main 依赖它们），不拦的话 initChatModel 会静默建出一个本地直连
  // client，把请求打到厂商而绕过云网关。
  const modelProvider = PROVIDER_MODEL_NAME[config.providerType];
  if (!modelProvider) {
    throw new Error(
      `本地轨不支持的 providerType：${config.providerType}。` +
        `本地轨只经云网关取模型，真实厂商调用发生在 server-main 的 model-gateway；` +
        `请检查 model_configs 表是否残留 source='local' 的旧行。`,
    );
  }

  const configuration: Record<string, unknown> = {};
  if (config.baseUrl) configuration.baseURL = config.baseUrl;
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
    modelProvider,
    apiKey: config.apiKey,
    ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
    streaming: options?.streaming ?? true,
    ...(debugCallback ? { callbacks: [debugCallback] } : {}),
  })) as BaseChatModel;
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
