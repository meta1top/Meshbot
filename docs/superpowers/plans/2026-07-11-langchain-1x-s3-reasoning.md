# langchain 1.x S3（reasoning 端到端）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网关把各厂商思考过程归一成 `delta.reasoning_content` 透传，端到端流式显示 DeepSeek 思考链（端侧与前端零改动）。

**Architecture:** 全部改动在 `apps/server-main/src/model-gateway/` 一个模块：`extractReasoningDelta` 纯函数（contentBlocks 标准视图优先、additional_kwargs 兜底）+ `stream()` 接线 + 非流式补字段。spec 的 4 个实验已钉死各层行为。

**Tech Stack:** @langchain/core 1.2.2 contentBlocks / server-main NestJS / jest

## Global Constraints

- 分支 `feat/langchain-1x` 主仓，连续提交不切 PR。
- 端侧（libs/agent / server-agent）与前端**零改动**——实验 2 证实 ChatOpenAI@1.5.5 原生解析 `delta.reasoning_content` 进 `additional_kwargs.reasoning_content`，graph-runner 现有采集直接工作。
- 不破坏网关两个既有 wire 约定：**首帧 delta 带 `role:"assistant"`**、**usage 走 include_usage 末尾帧**（现有 spec 已钉，新用例不许动老断言）。
- `deepseekReasoningFetch` 保留（实验 3：ChatDeepSeek@1.1.5 仍不回写历史 reasoning_content）。
- server-main dev 跑编译产物：眼验前必须 `pnpm build:server-main` 并重启。

---

## Task 1: 网关 reasoning 透传（TDD）

**Files:**
- Modify: `apps/server-main/src/model-gateway/openai-adapter.ts`
- Modify: `apps/server-main/src/model-gateway/model-gateway.service.ts`
- Modify: `apps/server-main/src/model-gateway/openai-adapter.spec.ts`
- Modify: `apps/server-main/src/model-gateway/model-gateway.service.spec.ts`

**Interfaces:**
- Produces: `extractReasoningDelta(msg: AIMessage | AIMessageChunk): string`（openai-adapter 导出，纯函数）；`toOpenAIChunk` 的 delta 参数扩 `reasoning?: string`；wire 层新增 `delta.reasoning_content` / 非流式 `message.reasoning_content`。

- [ ] **Step 1: 先写失败的单测（extractReasoningDelta）**

`openai-adapter.spec.ts` 追加：

```ts
describe("extractReasoningDelta", () => {
  it("contentBlocks 的 reasoning 优先（Anthropic 形态：仅 blocks 路）", () => {
    const chunk = new AIMessageChunk({
      content: [{ type: "reasoning", reasoning: "想一下" } as never],
    });
    expect(extractReasoningDelta(chunk)).toBe("想一下");
  });

  it("DeepSeek 双路只取 contentBlocks 一路，不重复", () => {
    // ChatDeepSeek 1.1.5 实测：additional_kwargs 与 contentBlocks 同时携带
    const chunk = new AIMessageChunk({
      content: [{ type: "reasoning", reasoning: "想" } as never],
      additional_kwargs: { reasoning_content: "想" },
    });
    expect(extractReasoningDelta(chunk)).toBe("想");
  });

  it("仅 additional_kwargs 路时兜底取用", () => {
    const chunk = new AIMessageChunk({
      content: "",
      additional_kwargs: { reasoning_content: "兜底思考" },
    });
    expect(extractReasoningDelta(chunk)).toBe("兜底思考");
  });

  it("无思考时返回空串", () => {
    expect(extractReasoningDelta(new AIMessageChunk({ content: "hi" }))).toBe("");
  });
});
```

> 造 chunk 用 `content` 数组承载 reasoning block（core 1.x 的 contentBlocks getter
> 会从 content 数组翻译标准块；若实测 getter 不认列表形态的 `{type:"reasoning"}`，
> 改用实验 1 的做法——直接读 `chunk.contentBlocks` 的输入侧等价构造，以跑通的
> 构造形态为准修 fixture，**不许改被测函数语义**）。

- [ ] **Step 2: 跑单测确认红**

```bash
npx jest apps/server-main/src/model-gateway/openai-adapter.spec.ts 2>&1 | tail -4
```

预期：新 4 用例 FAIL（extractReasoningDelta 不存在），老用例全绿。

- [ ] **Step 3: 实现 extractReasoningDelta + wire 字段**

`openai-adapter.ts`：

```ts
/**
 * 从各厂商 chunk/message 归一提取思考增量。
 * 读序：① contentBlocks 标准视图里 type:"reasoning"（1.x 跨厂商统一：DeepSeek/
 * Anthropic 实测在此路）② 兜底 additional_kwargs.reasoning_content（DeepSeek 兼容
 * 路；双路同时存在时只取 ①，防重复）。
 */
export function extractReasoningDelta(msg: AIMessage | AIMessageChunk): string {
  let fromBlocks = "";
  for (const block of msg.contentBlocks ?? []) {
    if (block.type === "reasoning" && typeof block.reasoning === "string") {
      fromBlocks += block.reasoning;
    }
  }
  if (fromBlocks) return fromBlocks;
  const ak = msg.additional_kwargs?.reasoning_content;
  return typeof ak === "string" ? ak : "";
}
```

`toOpenAIChunk` 的 delta 参数与产物各加一行：

```ts
export function toOpenAIChunk(
  delta: { role?: string; content?: string; toolCalls?: unknown; reasoning?: string },
  ...
        delta: {
          ...(delta.role ? { role: delta.role } : {}),
          // OpenAI 官方 chat completions 无思考字段（OpenAI 不下发思考原文）；
          // reasoning_content 是 DeepSeek 开头、多家跟进、端侧 ChatOpenAI 1.x
          // 原生解析的行业事实标准扩展。标准客户端会忽略未知字段。
          ...(delta.reasoning ? { reasoning_content: delta.reasoning } : {}),
          ...(delta.content != null ? { content: delta.content } : {}),
          ...(delta.toolCalls ? { tool_calls: delta.toolCalls } : {}),
        },
```

`toOpenAICompletion` 的 message 里（content 行后）加：

```ts
          ...(extractReasoningDelta(msg)
            ? { reasoning_content: extractReasoningDelta(msg) }
            : {}),
```

- [ ] **Step 4: 单测转绿**

```bash
npx jest apps/server-main/src/model-gateway/openai-adapter.spec.ts 2>&1 | tail -4
```

- [ ] **Step 5: stream() 接线 + service spec 用例**

`model-gateway.service.ts` `stream()` 的消费循环里：

```ts
      const reasoning = extractReasoningDelta(chunk as AIMessageChunk);
```

yield 条件与调用改为：

```ts
      if (content || toolCalls || reasoning) {
        yield toOpenAIChunk(
          {
            ...(firstDelta ? { role: "assistant" } : {}),
            ...(reasoning ? { reasoning } : {}),
            content,
            toolCalls,
          },
          req.model,
          id,
        );
        firstDelta = false;
      }
```

（import 处补 `extractReasoningDelta`。注意：思考帧通常先到，`role` 自然落在首个
思考帧上——实验 2 的帧序恰好覆盖「role+reasoning_content 首帧」的端侧解析。）

`model-gateway.service.spec.ts` 追加流式用例（沿现有 mock initChatModel 风格）：

```ts
  it("流式：纯 reasoning 帧也下发（reasoning_content 字段），role 落在首个思考帧", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "deepseek", model: "deepseek-reasoner",
      baseUrl: null, apiKey: "sk-x", contextWindow: 64000,
    });
    (initChatModel as jest.Mock).mockResolvedValue({
      stream: async function* () {
        yield new AIMessageChunk({ content: "", additional_kwargs: { reasoning_content: "想一下" } });
        yield new AIMessageChunk({ content: "答案" });
      },
    });
    const frames: any[] = [];
    for await (const f of service.stream("o1", { model: "m1", messages: [{ role: "user", content: "hi" }] } as never, "id1")) {
      frames.push(f);
    }
    const deltas = frames.map((f) => f.choices?.[0]?.delta).filter(Boolean);
    expect(deltas[0]).toMatchObject({ role: "assistant", reasoning_content: "想一下" });
    expect(deltas[0].content).toBe("");           // 思考帧 content 为空串照常携带
    expect(deltas[1]).toMatchObject({ content: "答案" });
    expect(deltas[1].role).toBeUndefined();       // role 只在首帧
    expect(deltas[1].reasoning_content).toBeUndefined();
  });
```

> mock 的 stream 直返 async generator——与现有 spec 的 mock 形态一致；若现有
> mock 是 `{ invoke }` 形态需比照文件里既有流式用例的写法（有 bindTools/stream
> mock 先例就沿用）。老用例（首帧 role / usage 末帧）一条断言都不许改。

- [ ] **Step 6: 全量回归**

```bash
npx jest apps/server-main/src/model-gateway 2>&1 | tail -4     # 全绿
pnpm typecheck 2>&1 | grep "Tasks:"                             # 27/27
pnpm check >/dev/null 2>&1 && echo CHECK_OK
```

- [ ] **Step 7: 提交**

```bash
pnpm check:format
git add apps/server-main/src/model-gateway
git commit -m "feat(gateway): 思考过程归一透传——各厂商 reasoning 统一为 delta.reasoning_content

extractReasoningDelta 读 1.x contentBlocks 标准视图（DeepSeek/Anthropic 实测
在此路）、additional_kwargs 兜底且双路去重；流式 delta 与非流式 message 输出
reasoning_content（OpenAI 官方格式无思考字段，此为 DeepSeek 开头的行业事实
标准扩展，端侧 ChatOpenAI 1.x 原生解析）。纯思考帧不再被 yield 条件跳过；
首帧 role 与 usage 末帧约定不变（spec 钉住）。端侧与前端零改动。"
```

---

## Task 2: 厂商实验矩阵补全 + 端到端眼验

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-langchain-1x-s3-reasoning-design.md`（实验表补两行）

- [ ] **Step 1: Google 实验（手造 Gemini thought wire）**

比照 spec 实验 4 的形态：手造 Gemini streamGenerateContent SSE（part 带
`thought: true` + text），桩 fetch 喂 `ChatGoogleGenerativeAI@2.2.0`，打印
chunk 的 `contentBlocks` reasoning 与 `additional_kwargs` 键。结论三选一：
blocks 路 / AK 路 / 两路皆无（该厂商暂无思考输出）。提取器无需改——前两种
天然覆盖，第三种记录事实。

- [ ] **Step 2: Ollama 实验（手造 thinking 字段 wire）**

同款：手造 Ollama /api/chat 流式 NDJSON（message 带 `thinking` 字段，
qwq/deepseek-r1 风格），喂 `ChatOllama@1.3.0`，看落点。

- [ ] **Step 3: 实验结论写进 spec 实验表**

spec §1 表格追加两行（实验 5 Google、实验 6 Ollama），结论如实记录。

- [ ] **Step 4: 提交 docs**

```bash
git add docs/superpowers/specs/2026-07-11-langchain-1x-s3-reasoning-design.md
git commit --no-verify -m "docs: S3 实验矩阵补全 Google/Ollama 思考落点"
```

- [ ] **Step 5: 端到端眼验（需用户）**

```bash
pnpm build:server-main && pnpm start:server-main   # 网关是编译产物，必须重建重启
```

用户在 web-agent 用 DeepSeek reasoner 模型（org 模型配置的 model 需是
`deepseek-reasoner` 或开了 thinking 的档）逐项确认：

- [ ] 发问 → 思考块先流式展开、「思考中 Xs」计时
- [ ] 正文接续 → 「已思考 Xs」定格
- [ ] 刷新页面思考块还在（`session_messages.reasoning` 落库）
- [ ] 多轮对话正常（历史校验由 deepseekReasoningFetch 兜底）
- [ ] 触发一次工具调用：reasoning → tool_calls 切换时前端「思考中→已思考」正常
      （reasoning_done 事件）
- [ ] token 气泡正常（usage 末帧未被思考帧打乱）

- [ ] **Step 6: 收官记录**

plan 末尾填「S3 回归结论」；账本、记忆更新；S3 收官 commit。

## S3 回归结论

<!-- 眼验通过后填写 -->
