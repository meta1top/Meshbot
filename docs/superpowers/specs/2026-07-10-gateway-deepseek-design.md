# DeepSeek 接入云模型网关 设计 spec

**日期:** 2026-07-10
**分支:** 当前 worktree `worktree-gateway-deepseek`(off origin/main c5c6197)

## 背景与问题

云模型网关(server-main,PR #33)当前在 `ModelGatewayService.build()` 里对 `resolved.providerType === "deepseek"` 直接抛 `GatewayModelNotFoundError`(注释:"DeepSeek v1 不经网关,端侧直连")。但云端下发逻辑(`ModelConfigSyncService.toGatewayRow`)把**所有**云模型——包括 DeepSeek——无差别落成"指向网关的 `openai-compatible` 行"。两者矛盾:配置 DeepSeek 云模型 → agent 把配置 id 当 model 发网关 → 网关按 id 解析回 `providerType=deepseek` → 拒绝 → `404 model not found: <配置id>`,run 失败。

这个拒绝是 PR #33 的**未完成短路**,不是终态设计。spec `2026-07-09-cloud-model-gateway-design.md` §75-79 已把"deepseek 经网关"标为待办(默认"网关侧处理"),只是 v1 没做。

## 架构确认(本次澄清)

- **server-main = 统一厂商网关**:内部对接各厂商(deepseek/openai/anthropic/google/…),对 agent 只暴露**一个 OpenAI 兼容接口**;厂商差异全在网关内部消化。
- **server-agent = 纯 OpenAI 兼容客户端**:云模型一律经网关以 openai 兼容方式请求。本地直连(Ollama/vllm 等 `source='local'`)**预留、暂不实现**。
- 推论:**agent 侧对"云端 DeepSeek"路径无需任何改动**。下发行本就是 `provider_type=openai-compatible` 指向网关。端侧现有 deepseek 专属处理(`llm.factory.ts` 的 `patchedFetchForDeepseek` + `supervisor.node.ts` reasoning 剥离)只在 `provider_type==="deepseek"`(本地直连)才触发,对云端是死路径,**不动、不删**(留给将来本地直连)。

## 目标

- 云端 DeepSeek 组织模型经网关端到端可用(chat + 多轮 + 工具调用)。
- 所有 DeepSeek 处理收敛在**网关内部**;agent 保持纯净。
- 思考链(reasoning_content)走 **A:不对外暴露**——网关内部消化,OpenAI 兼容出站只给标准 `content` + `tool_calls`。

## 非目标(YAGNI)

- **不**改 server-agent / libs/agent(云端路径无需)。
- **不**做本地直连 DeepSeek(source='local',预留)。
- **不**对外暴露 / 渲染思考链(方案 B);**不**做用量记录 / 限流。

## 改动(全在 server-main)

**文件:**
- Modify `apps/server-main/package.json` — 加依赖 `@langchain/deepseek@0.1.0`(与 libs/agent 对齐)。
- Modify `apps/server-main/src/model-gateway/model-gateway.service.ts` — 去拒绝、加 provider 映射、挂 reasoning fetch。
- Create `apps/server-main/src/model-gateway/deepseek-fetch.ts` — 移植的 `deepseekReasoningFetch`(自包含,跨轨不 import libs/agent)。
- Modify `apps/server-main/src/model-gateway/model-gateway.service.spec.ts` — 改 deepseek 用例。
- Create `apps/server-main/src/model-gateway/deepseek-fetch.spec.ts` — fetch 注入单测。

**逻辑:**
1. `model-gateway.service.ts` `PROVIDER_MODEL_NAME` 加 `deepseek: "deepseek"`(让 `initChatModel` 加载 `@langchain/deepseek`)。
2. 删掉 `build()` 里 `if (resolved.providerType === "deepseek") throw new GatewayModelNotFoundError(req.model);` 三行。
3. `build()` 里在设置 `configuration` 时:`if (resolved.providerType === "deepseek") configuration.fetch = deepseekReasoningFetch(globalThis.fetch);`(顺序在 baseURL 之后、initChatModel 之前)。
4. 订正 `GatewayModelNotFoundError` 上"含 deepseek v1 不经网关"的过时注释。
5. **出站零改动**:`openai-adapter.ts` 的 `toOpenAICompletion` / `toOpenAIChunk` 本就只吐 `content` + `tool_calls`,ChatDeepSeek 的 reasoning 在 `additional_kwargs` 不进 `content`,自然不外露(满足 A)。

**`deepseekReasoningFetch`(deepseek-fetch.ts):** 移植自 `libs/agent/src/graph/llm.factory.ts:177-206` 的 `patchedFetchForDeepseek`,去掉 debug `console.log`:

```ts
/**
 * fetch 包装:拦 POST /chat/completions 的 JSON body,给 role=assistant 且
 * 缺 reasoning_content 的消息补空 reasoning_content —— DeepSeek thinking 模式
 * 要求历史 assistant 消息带该字段,否则多轮请求被服务端校验拒。
 */
export function deepseekReasoningFetch(base: typeof fetch): typeof fetch {
  return async function patched(input, init) {
    if (!init?.body || typeof init.body !== "string") return base(input, init);
    let body: { messages?: Array<Record<string, unknown>> };
    try {
      body = JSON.parse(init.body);
    } catch {
      return base(input, init);
    }
    if (!Array.isArray(body.messages)) return base(input, init);
    let patched = false;
    for (const msg of body.messages) {
      if (msg.role === "assistant" && msg.reasoning_content === undefined) {
        msg.reasoning_content = "";
        patched = true;
      }
    }
    if (!patched) return base(input, init);
    return base(input, { ...init, body: JSON.stringify(body) });
  };
}
```

## 数据流(改后)

云端建 DeepSeek OrgModelConfig(provider=deepseek, model=deepseek-*, key=真实 key,云端加密持有)→ 下发 agent 落 openai-compatible 行(model=配置id,指向网关)→ agent 以 openai 兼容调网关 → 网关 `resolveDecrypted` 解出 provider=deepseek + 真实 key → `build()` 用 `initChatModel(model, {modelProvider:"deepseek", apiKey, configuration:{baseURL, fetch: deepseekReasoningFetch}})` → 调 DeepSeek → 结果经 `openai-adapter` 只回 content/tool_calls(reasoning 丢弃)→ SSE/JSON 回 agent。

## 错误处理

- 未知 model id / 非本 org / 未 enabled → `resolveDecrypted` 返回 null → 仍 `GatewayModelNotFoundError` → 404(不变)。
- DeepSeek 厂商侧错误(超时/限流/key 无效)→ 走 `build()` 之后的调用,由 Controller 现有非 `GatewayModelNotFoundError` 分支处理(流式:净化日志 + `gateway error`;非流式:抛出)。不新增处理。

## 测试

- **改** `model-gateway.service.spec.ts` 现有 "deepseek 模型 → 抛 GatewayModelNotFoundError"(约 :59):改为断言 **deepseek 正常构建**——mock `initChatModel`,`complete`/`build` 不抛;`initChatModel` 收到 `modelProvider:"deepseek"`;`configuration.fetch` 已设置(deepseek 分支)。TDD:先改断言看它失败(现行为会抛),再改实现转绿。
- **新增** `deepseek-fetch.spec.ts`:`deepseekReasoningFetch` 给 assistant 消息注入 `reasoning_content:""`;非 assistant / 已带字段 / 非 JSON body / 无 body 时透传不改。用 mock base fetch 断言最终 body。
- 保留原有"真·模型不存在(null)→ 抛错"用例(流式 + 非流式)。
- 端到端眼验(需 server-main + 有真实 DeepSeek key 的组织):建 DeepSeek 云模型 → agent 起 run → 不再 404、能正常出话。

## 影响面

- 改:server-main model-gateway(+ 一个新依赖)。
- 不改:server-agent / libs/agent、下发逻辑、openai-adapter、agent 端 deepseek 本地直连路径。
