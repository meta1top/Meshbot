# 云网关透传 token usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 云模型网关把上游模型的 token usage 按 OpenAI 规范透传给端侧（非流式 `completion.usage` + 流式末尾 `include_usage` 帧），修复所有云模型 `llm_calls`/token 气泡全 0 与 `no usage_metadata` 告警。

**Architecture:** 仅改 server-main 网关的 OpenAI 适配。新增 `usage_metadata`(langchain) → OpenAI `usage` 映射；`toOpenAICompletion` 带上 `usage`；`stream()` 记录上游末个 `usage_metadata`，内容/finish 帧后补一个 `{choices:[], usage}` 帧。端侧 `ChatOpenAI` 会自动把该帧解析进 `usage_metadata`（已 mock 验证），agent 现有 `extractUsage → LlmCall → 气泡`链路无需改。

**Tech Stack:** NestJS (server-main) + langchain `@langchain/core` messages（`AIMessage`/`AIMessageChunk`/`usage_metadata`）+ Jest（根配置，ts-jest，node env）。

## Global Constraints

- **改动全在 server-main model-gateway**；**不改** server-agent / libs/agent / 下发逻辑 / 鉴权 / 路由 / 其余 provider 行为。
- **不做** reasoning 思考链显示（另立后续；langchain 不解析 `delta.reasoning_content`）。**不新增依赖**。
- usage 映射：langchain `{input_tokens, output_tokens, total_tokens}` → OpenAI `{prompt_tokens, completion_tokens, total_tokens}`；字段缺失按 0，`total_tokens` 缺失用 input+output。
- 流式 usage 帧遵循 OpenAI include_usage 约定：`choices:[]` 空、带 `usage`；**无条件发**（唯一消费者是 agent ChatOpenAI，已证实能解析）。
- 上游无 `usage_metadata` → **不发 usage 帧 / completion 不加 usage**，退回当前行为，不报错、不臆造。
- 不触碰既有逻辑：`GatewayModelNotFoundError`、deepseek reasoning fetch、流式首帧 `role:"assistant"`、finish 帧、`[DONE]`。
- 纯逻辑单测走**根 jest**（`.ts`、相对 import）；只跑针对性 `pnpm exec jest apps/server-main/src/model-gateway/`（全量 `pnpm test` 有既有无关失败）。
- 中文 conventional commit，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 命令在仓库根 `/Users/grant/Meta1/meshbot` 执行（当前检出在分支 `worktree-gateway-deepseek`）。

## 文件结构

- **Modify** `apps/server-main/src/model-gateway/openai-adapter.ts` — 新增私有 `toOpenAIUsage` 映射；`toOpenAICompletion` 带 `usage`；新增导出 `toOpenAIUsageChunk`。
- **Modify** `apps/server-main/src/model-gateway/model-gateway.service.ts` — `stream()` 记录上游 `usage_metadata`、末尾发 usage 帧。
- **Modify** `apps/server-main/src/model-gateway/model-gateway.service.spec.ts` — 补/改断言（非流式 usage、流式 usage 帧、无 usage 回归）。

---

### Task 1: 非流式 completion.usage + usage 映射

**Files:**
- Modify: `apps/server-main/src/model-gateway/openai-adapter.ts`
- Modify: `apps/server-main/src/model-gateway/model-gateway.service.spec.ts`

**Interfaces:**
- Produces:
  - `toOpenAIUsage(u: { input_tokens?: number; output_tokens?: number; total_tokens?: number }): { prompt_tokens: number; completion_tokens: number; total_tokens: number }` —— openai-adapter.ts 内**私有**（不导出），Task 2 的 `toOpenAIUsageChunk` 复用。
  - `toOpenAICompletion(msg, model, id)` —— 当 `msg.usage_metadata` 存在时返回对象含顶层 `usage`。

- [ ] **Step 1: 先改失败断言**——在 `model-gateway.service.spec.ts` 把现有 "解析 → 调 provider → 返回 OpenAI completion" 用例（约 :28）整段替换为带 usage 断言的版本，并在其后新增"无 usage"回归用例：

```ts
  it("解析 → 调 provider → 返回 OpenAI completion（含 usage）", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk-x",
      contextWindow: 128000,
    });
    (initChatModel as jest.Mock).mockResolvedValue({
      invoke: async () =>
        new AIMessage({
          content: "hi from provider",
          usage_metadata: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
        }),
    });

    const out: any = await service.complete(
      "o1",
      { model: "m1", messages: [{ role: "user", content: "hi" }] },
      "cmpl-1",
    );

    expect(out.choices[0].message.content).toBe("hi from provider");
    expect(initChatModel).toHaveBeenCalledWith(
      "gpt-4o",
      expect.objectContaining({ apiKey: "sk-x" }),
    );
    // langchain usage_metadata → OpenAI usage 映射
    expect(out.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
  });

  it("非流式：上游无 usage_metadata → completion 不含 usage", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk",
      contextWindow: null,
    });
    (initChatModel as jest.Mock).mockResolvedValue({
      invoke: async () => new AIMessage("no-usage"),
    });

    const out: any = await service.complete(
      "o1",
      { model: "m1", messages: [] },
      "id",
    );
    expect(out.usage).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/server-main/src/model-gateway/model-gateway.service.spec.ts -t "completion"`
Expected: FAIL —— "含 usage" 用例 `out.usage` 为 `undefined`（现 `toOpenAICompletion` 不吐 usage）。"无 usage" 用例此刻已通过（现在本就没 usage 字段）。

- [ ] **Step 3: 实现 `openai-adapter.ts`**

在 `textOf` 之后、`toOpenAICompletion` 之前，新增映射：

```ts
/**
 * langchain UsageMetadata → OpenAI usage。字段缺失按 0 兜底；
 * total_tokens 缺失时用 input+output 兜底。
 */
function toOpenAIUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}) {
  const prompt = u.input_tokens ?? 0;
  const completion = u.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.total_tokens ?? prompt + completion,
  };
}
```

在 `toOpenAICompletion` 的返回对象里，`choices` 同级加 `usage`（`msg.usage_metadata` 存在才加）：

```ts
export function toOpenAICompletion(msg: AIMessage, model: string, id: string) {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textOf(msg.content),
          ...(msg.tool_calls?.length
            ? {
                tool_calls: msg.tool_calls.map((tc) =>
                  convertLangChainToolCallToOpenAI(tc),
                ),
              }
            : {}),
        },
        finish_reason: msg.tool_calls?.length ? "tool_calls" : "stop",
      },
    ],
    ...(msg.usage_metadata ? { usage: toOpenAIUsage(msg.usage_metadata) } : {}),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec jest apps/server-main/src/model-gateway/model-gateway.service.spec.ts -t "completion"`
Expected: PASS（"含 usage" + "无 usage" 两用例均绿）。

- [ ] **Step 5: 提交**

```bash
git add apps/server-main/src/model-gateway/openai-adapter.ts \
        apps/server-main/src/model-gateway/model-gateway.service.spec.ts
git commit -m "feat(gateway): 非流式 completion 透传 usage（usage_metadata→OpenAI usage 映射）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 流式末尾 usage 帧

**Files:**
- Modify: `apps/server-main/src/model-gateway/openai-adapter.ts`（新增 `toOpenAIUsageChunk`）
- Modify: `apps/server-main/src/model-gateway/model-gateway.service.ts`（`stream()` 记录并末尾发 usage 帧）
- Modify: `apps/server-main/src/model-gateway/model-gateway.service.spec.ts`（改流式用例 + 无 usage 回归）

**Interfaces:**
- Consumes: Task 1 的私有 `toOpenAIUsage`（同文件）。
- Produces: `toOpenAIUsageChunk(usage, model, id)` —— 产出 `{ id, object:"chat.completion.chunk", created:0, model, choices:[], usage }`。

- [ ] **Step 1: 先改失败断言**——把 `model-gateway.service.spec.ts` 现有 "流式：逐 chunk yield OpenAI 帧" 用例整段替换（给末个上游 chunk 带 usage_metadata、断言末尾 usage 帧、修正 finish 断言），并新增"无 usage"回归：

```ts
  it("流式：逐 chunk yield OpenAI 帧 + 末尾 usage 帧", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk",
      contextWindow: null,
    });
    (initChatModel as jest.Mock).mockResolvedValue({
      stream: async function* () {
        yield new AIMessageChunk("he");
        yield new AIMessageChunk({
          content: "llo",
          usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        });
      },
    });

    const frames: any[] = [];
    for await (const f of service.stream(
      "o1",
      { model: "m1", messages: [{ role: "user", content: "hi" }], stream: true },
      "id",
    )) {
      frames.push(f);
    }

    expect(frames[0].choices[0].delta.role).toBe("assistant");
    expect(frames[0].choices[0].delta.content).toBe("he");
    expect(frames[1].choices[0].delta.content).toBe("llo");
    // finish 帧仍在（content 帧之后）
    expect(
      frames.some((f) => f.choices[0]?.finish_reason === "stop"),
    ).toBe(true);
    // 末尾 usage 帧：choices 空、带映射后的 usage（OpenAI include_usage 约定）
    const usageFrame = frames.find(
      (f) => Array.isArray(f.choices) && f.choices.length === 0 && f.usage,
    );
    expect(usageFrame.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  it("流式：上游无 usage_metadata → 不产出 usage 帧", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk",
      contextWindow: null,
    });
    (initChatModel as jest.Mock).mockResolvedValue({
      stream: async function* () {
        yield new AIMessageChunk("he");
        yield new AIMessageChunk("llo");
      },
    });

    const frames: any[] = [];
    for await (const f of service.stream(
      "o1",
      { model: "m1", messages: [], stream: true },
      "id",
    )) {
      frames.push(f);
    }
    const usageFrame = frames.find(
      (f) => Array.isArray(f.choices) && f.choices.length === 0 && f.usage,
    );
    expect(usageFrame).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/server-main/src/model-gateway/model-gateway.service.spec.ts -t "流式"`
Expected: FAIL —— "末尾 usage 帧" 用例找不到 usage 帧（现 `stream()` 不发）。"无 usage" 用例此刻已通过。

- [ ] **Step 3: 实现 `openai-adapter.ts` 新增 `toOpenAIUsageChunk`**

在 `toOpenAIChunk` 之后新增（复用 Task 1 的 `toOpenAIUsage`）：

```ts
/**
 * OpenAI include_usage 约定的末尾帧：choices 空、带 usage。
 * 端侧 langchain ChatOpenAI 会把它解析进最终 AIMessageChunk 的 usage_metadata。
 */
export function toOpenAIUsageChunk(
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number },
  model: string,
  id: string,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: toOpenAIUsage(usage),
  };
}
```

- [ ] **Step 4: 实现 `model-gateway.service.ts` `stream()`**

在 import 区，把 openai-adapter 的 import 补上 `toOpenAIUsageChunk`（与 `toOpenAIChunk` 等并列）。

`stream()` 里记录上游末个 `usage_metadata`，并在现有 finish 帧之后补发 usage 帧。把现有循环 + finish 帧那段：

```ts
    let firstDelta = true;
    for await (const chunk of await model.stream(toLangchainMessages(req))) {
      const content = typeof chunk.content === "string" ? chunk.content : "";
      const toolCalls = toOpenAIToolCallDeltas(
        (chunk as { tool_call_chunks?: ToolCallChunk[] }).tool_call_chunks,
      );
      if (content || toolCalls) {
        yield toOpenAIChunk(
          { ...(firstDelta ? { role: "assistant" } : {}), content, toolCalls },
          req.model,
          id,
        );
        firstDelta = false;
      }
    }
    yield {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
```

改为（新增 `usage` 追踪 + 末尾 usage 帧）：

```ts
    let firstDelta = true;
    let usage:
      | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
      | undefined;
    for await (const chunk of await model.stream(toLangchainMessages(req))) {
      const content = typeof chunk.content === "string" ? chunk.content : "";
      const toolCalls = toOpenAIToolCallDeltas(
        (chunk as { tool_call_chunks?: ToolCallChunk[] }).tool_call_chunks,
      );
      const chunkUsage = (
        chunk as {
          usage_metadata?: {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
          };
        }
      ).usage_metadata;
      // langchain streamUsage 默认开：末帧携带 usage_metadata，取末个非空的
      if (chunkUsage) {
        usage = chunkUsage;
      }
      if (content || toolCalls) {
        yield toOpenAIChunk(
          { ...(firstDelta ? { role: "assistant" } : {}), content, toolCalls },
          req.model,
          id,
        );
        firstDelta = false;
      }
    }
    yield {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    if (usage) {
      yield toOpenAIUsageChunk(usage, req.model, id);
    }
```

- [ ] **Step 5: 跑网关全部单测确认通过**

Run: `pnpm exec jest apps/server-main/src/model-gateway/`
Expected: PASS（流式 usage 帧 + 无 usage 回归 + Task 1 completion + 其余全绿）。

- [ ] **Step 6: typecheck**

Run: `pnpm --filter @meshbot/server-main typecheck`
Expected: exit 0。

- [ ] **Step 7: 提交**

```bash
git add apps/server-main/src/model-gateway/openai-adapter.ts \
        apps/server-main/src/model-gateway/model-gateway.service.ts \
        apps/server-main/src/model-gateway/model-gateway.service.spec.ts
git commit -m "feat(gateway): 流式末尾补 include_usage 帧，透传 token 用量到端侧

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: 端到端眼验（重启 server-main）**

单测 mock 了上游 stream 携带 `usage_metadata`；真实上游是否上报靠眼验。重启 server-main（重建 dist）→ app 发一条消息 →
- Expected: token 气泡显示真实"输入/输出/累计"、"次调用" ≥1；`.meshbot/main.db` 的 `llm_calls` 新增该会话记录（`output_tokens>0`）；server-agent 日志不再出现 `no usage_metadata`。
- 若气泡仍 0：查 server-agent 日志 `[LLM end]` 是否仍 `no usage_metadata`（→ 上游没上报 usage，需查网关内 `initChatModel` 的 `streamUsage`/provider 支持）。

---

## 自检（对照 spec）

- **spec 覆盖:**
  - 「非流式 completion.usage」→ Task 1。✅
  - 「usage 映射（input→prompt 等，缺失兜底）」→ Task 1 `toOpenAIUsage`。✅
  - 「流式末尾 include_usage 帧、无条件发」→ Task 2 `stream()` + `toOpenAIUsageChunk`。✅
  - 「上游无 usage → 不发/不加，退回当前行为」→ Task 1/2 各一条回归用例。✅
  - 「不改 agent、不新增依赖、不碰 role/finish/deepseek 逻辑」→ 改动清单仅 3 文件、finish 帧保留、role 首帧保留。✅
  - 「端到端眼验：气泡/llm_calls/告警」→ Task 2 Step 8。✅
- **placeholder 扫描:** 无 TBD/TODO；每步含完整代码或精确命令。✅
- **类型一致性:** `toOpenAIUsage` 私有签名在 Task 1 定义，Task 2 的 `toOpenAIUsageChunk` 同文件复用；`toOpenAIUsageChunk(usage, model, id)` 在 Task 2 定义并被 `stream()` 按此调用。✅
- **测试局限:** 单测 mock 上游 usage_metadata，只验网关"有 usage 就转发"；真实上游是否上报 usage 靠 Step 8 眼验。已在 Step 8 标注排查路径。
