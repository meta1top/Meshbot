/**
 * Provider 构建期冒烟断言（不联网），在**独立 Node 进程**里跑。
 *
 * 为什么不直接在 jest 里跑：langchain 1.x 的 `initChatModel` 内部用原生动态
 * `import()` 加载厂商包（ESM-first），jest 的 CJS VM 沙箱不支持
 * （报 "A dynamic import callback was invoked without --experimental-vm-modules"）。
 * Node CJS/ESM 运行时原生支持动态 import()——生产路径无碍，只有 jest 沙箱瘸。
 * 因此断言下沉到本脚本，由 provider-smoke.spec.ts 用子进程调起。
 *
 * 输出：每条断言一行 "PASS <name>" 或 "FAIL <name>: <err>"；全过 exit 0，否则 1。
 */
import { HumanMessage } from "@langchain/core/messages";
import { initChatModel } from "langchain/chat_models/universal";

const PROVIDER_CASES = [
  { modelProvider: "openai", model: "gpt-4o", apiKey: "sk-fake" },
  { modelProvider: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-ant-fake" },
  { modelProvider: "deepseek", model: "deepseek-chat", apiKey: "sk-fake" },
  { modelProvider: "google-genai", model: "gemini-2.0-flash", apiKey: "fake-key" },
  { modelProvider: "ollama", model: "llama3.2", apiKey: "unused" },
];

const OPENAI_TOOL = {
  type: "function",
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

function cannedCompletion() {
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

let failed = 0;
function report(name, err) {
  if (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message ?? err}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

// 1) 5 个 provider：动态 import 成功、能构建、能 bindTools
for (const { modelProvider, model, apiKey } of PROVIDER_CASES) {
  try {
    const chat = await initChatModel(model, {
      modelProvider,
      apiKey,
      streaming: false,
    });
    if (typeof chat.invoke !== "function") throw new Error("invoke 不是函数");
    if (typeof chat.stream !== "function") throw new Error("stream 不是函数");
    chat.bindTools([OPENAI_TOOL]);
    report(`build:${modelProvider}`);
  } catch (e) {
    report(`build:${modelProvider}`, e);
  }
}

// 2) OpenAI 兼容线（openai/deepseek）：configuration.fetch 被底层 client 真正使用
for (const modelProvider of ["openai", "deepseek"]) {
  try {
    let calls = 0;
    const fetchSpy = async () => {
      calls++;
      return cannedCompletion();
    };
    const chat = await initChatModel(
      modelProvider === "openai" ? "gpt-4o" : "deepseek-chat",
      {
        modelProvider,
        apiKey: "sk-fake",
        streaming: false,
        configuration: { baseURL: "https://provider.invalid/v1", fetch: fetchSpy },
      },
    );
    const res = await chat.invoke([new HumanMessage("ping")]);
    if (calls !== 1) throw new Error(`fetch 被调用 ${calls} 次，期望 1`);
    if (res.content !== "pong") throw new Error(`content=${JSON.stringify(res.content)}，期望 "pong"`);
    report(`fetch:${modelProvider}`);
  } catch (e) {
    report(`fetch:${modelProvider}`, e);
  }
}

process.exit(failed === 0 ? 0 : 1);
