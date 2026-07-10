import { HumanMessage } from "@langchain/core/messages";
import { initChatModel } from "langchain/chat_models/universal";

/**
 * Provider 构建期冒烟测（不联网）。
 *
 * 为什么需要：网关经 `initChatModel` 动态加载厂商包，而它的签名是
 * `initChatModel(model: string, fields?: Partial<Record<string, any>> & {...})`
 * —— `configuration` / `streaming` / `modelKwargs` 全部逃过 typecheck，
 * 全仓也没有任何一处 `new ChatOpenAI` 让编译器抓到 provider 的破坏性变更。
 *
 * 升级 langchain 大版本时，这里是唯一能在不联网、无真实 apiKey 的前提下
 * 发现下列四类破坏的防线：
 *   1. 动态 import 挂了（包名/导出路径变了）
 *   2. 构造参数改名（apiKey / streaming / configuration）
 *   3. bindTools 签名或入参格式变了
 *   4. configuration.fetch 不再被底层 client 使用（云网关的地基）
 *
 * 本文件**刻意不 mock** `initChatModel`（对比 model-gateway.service.spec.ts）。
 *
 * ⚠️ open handle：5 个 provider SDK（openai/anthropic/google-genai/ollama/deepseek）
 * 在 `initChatModel` 构造时会建网络传输层（keep-alive agent / undici dispatcher），
 * 留下不会自动关闭的 handle。所有断言正常通过，但 jest 会在跑完后挂起等 handle。
 * afterAll 里显式关掉 undici 全局 dispatcher + Node 全局 http(s) agent 让进程干净退出；
 * 若某 provider 用了别的传输层仍挂起，跑这个文件用 `--forceExit`。
 */

/** 与 model-gateway.service.ts 的 PROVIDER_MODEL_NAME 映射保持一致。 */
const PROVIDER_CASES = [
  {
    providerType: "openai",
    modelProvider: "openai",
    model: "gpt-4o",
    apiKey: "sk-fake",
  },
  {
    providerType: "anthropic",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "sk-ant-fake",
  },
  {
    providerType: "deepseek",
    modelProvider: "deepseek",
    model: "deepseek-chat",
    apiKey: "sk-fake",
  },
  {
    providerType: "google",
    modelProvider: "google-genai",
    model: "gemini-2.0-flash",
    apiKey: "fake-key",
  },
  {
    providerType: "ollama",
    modelProvider: "ollama",
    model: "llama3.2",
    apiKey: "unused",
  },
];

/** 网关把 OpenAI 线格式的 tools 原样喂给 bindTools，见 model-gateway.service.ts。 */
const OPENAI_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

/** OpenAI 线格式的固定 completion 响应，供桩 fetch 返回。 */
function cannedCompletion(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion",
      created: 0,
      model: "smoke",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "pong" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("provider 构建期冒烟（不联网）", () => {
  // provider SDK 构造时建的网络传输层不会自动关闭 → 显式收尾，让进程能干净退出。
  afterAll(async () => {
    try {
      const undici = await import("undici");
      await undici.getGlobalDispatcher().close();
    } catch {
      // undici 不是直接依赖时忽略——退回下面的全局 agent 清理。
    }
    const http = await import("node:http");
    const https = await import("node:https");
    http.globalAgent.destroy();
    https.globalAgent.destroy();
  });

  it.each(PROVIDER_CASES)(
    "$providerType：动态 import 成功、能构建、能 bindTools",
    async ({ modelProvider, model, apiKey }) => {
      const chat = await initChatModel(model, {
        modelProvider,
        apiKey,
        streaming: false,
      });

      expect(typeof (chat as { invoke?: unknown }).invoke).toBe("function");
      expect(typeof (chat as { stream?: unknown }).stream).toBe("function");
      expect(() => chat.bindTools([OPENAI_TOOL])).not.toThrow();
    },
  );

  // configuration.fetch 只对 OpenAI 兼容线（openai / deepseek）生效——
  // anthropic 用 clientOptions、google-genai 与 ollama 各有自己的传输层。
  // 云网关的 buildCloudFetch / deepseekReasoningFetch 都挂在这条线上。
  const FETCH_WIRED = PROVIDER_CASES.filter((c) =>
    ["openai", "deepseek"].includes(c.modelProvider),
  );

  it.each(FETCH_WIRED)(
    "$providerType：configuration.fetch 被底层 client 真正使用，且 completion 可解析",
    async ({ modelProvider, model, apiKey }) => {
      const fetchSpy = jest.fn(async () => cannedCompletion());

      const chat = await initChatModel(model, {
        modelProvider,
        apiKey,
        streaming: false,
        configuration: {
          baseURL: "https://provider.invalid/v1",
          fetch: fetchSpy,
        },
      });

      const res = await chat.invoke([new HumanMessage("ping")]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(res.content).toBe("pong");
    },
  );
});
