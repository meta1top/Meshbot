/**
 * fetch 包装：拦 POST /chat/completions 的 JSON body，给 role=assistant 且
 * 缺 reasoning_content 的消息补空 reasoning_content —— DeepSeek thinking 模式
 * 要求历史 assistant 消息带该字段，否则多轮请求被服务端校验拒。
 *
 * 移植自 libs/agent 的 patchedFetchForDeepseek；跨轨不 import，网关侧自包含。
 */
export function deepseekReasoningFetch(base: typeof fetch): typeof fetch {
  return async function patched(input, init) {
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
      return base(input, init);
    }
    let mutated = false;
    for (const msg of body.messages) {
      if (
        typeof msg === "object" &&
        msg !== null &&
        msg.role === "assistant" &&
        msg.reasoning_content === undefined
      ) {
        msg.reasoning_content = "";
        mutated = true;
      }
    }
    if (!mutated) {
      return base(input, init);
    }
    return base(input, { ...init, body: JSON.stringify(body) });
  };
}
