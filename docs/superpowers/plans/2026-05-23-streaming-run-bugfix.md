# 流式 run bug 修复 + 重试 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复流式 run 冒烟暴露的两个 bug（deepseek 集成包未装；同一用户消息在 history+pending 双计），并加 failed 状态 + 消息重试。

**Architecture:** 装全 PROVIDERS 对应的 `@langchain/*` 集成包修 Bug 1。Bug 2 根因是 run 出错时 HumanMessage 已进 checkpointer、pending 又回滚 —— 修法：让 `PendingMessage.id` 与写入 checkpointer 的 `HumanMessage.id` 一致，出错标 `failed`（不回滚），前端按 id 去重并把未处理消息单独渲染在输入框上方。`failed` 消息经 `POST /api/sessions/:id/retry` 重试 —— HumanMessage 已在会话里，重试只让 graph 从现有 checkpoint 状态重跑。

**Tech Stack:** LangChain `initChatModel` + provider 集成包、LangGraph、NestJS、Next.js、Jotai。

---

## 背景与约定（实施前必读）

- **仓库**：meshbot monorepo（pnpm + Turbo），当前分支 `main`。本特性动 `libs/agent`、`libs/types-agent`、`apps/server-agent`、`apps/web-agent`。
- **Bug 1**：`libs/agent/llm.factory.ts` 用 `initChatModel` 懒加载 `@langchain/<provider>` 包；一个 provider 集成包都没装。
- **Bug 2**：`streamMessage` run 开始就把 `HumanMessage` 写进 LangGraph checkpointer；run 出错时 `PendingMessage` 回滚 `pending` —— 同条消息 history（checkpointer）+ pending 表两边各一份，id 不同，前端无法去重。
- **测试**：server-agent / types-agent 用 Jest；`libs/agent` 用 vitest。
- **静态围栏**：改 `*.service.ts` / `*.controller.ts` 后 commit 前跑 `pnpm check`。
- **提交信息**：中文，conventional commits，结尾 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。
- **格式**：commit 前 `pnpm format`。禁止在 `if` 前一行放注释。公开方法中文 JSDoc。不用 `--no-verify`。
- pre-commit 跑围栏会改 `docs/audits/*.json` / 格式化 `scripts/*` —— 这些是噪音，commit 时只 `git add` 本任务的文件，不要带上无关改动。

## 文件结构总览

**修改：**
| 文件 | 改动 |
|---|---|
| `libs/agent/package.json` | 加 `@langchain/openai`/`anthropic`/`google-genai`/`deepseek`/`ollama` |
| `libs/agent/src/graph/llm.factory.ts` | provider→modelProvider 映射（如需） |
| `libs/types-agent/src/session.ts` | `PendingMessageStatus` 加 `failed`；加 `RetryResponse` |
| `libs/agent/src/graph/graph.service.ts` | `streamMessage` 接受 `{id,content}[]`；新增 `resumeStream` |
| `apps/server-agent/src/services/session.service.ts` | `markFailed`；`listActivePending` 含 failed；`claimFailed` |
| `apps/server-agent/src/services/runner.service.ts` | `runOnce` 传带 id 的批次；出错 `markFailed`；`kickRetry` + resume 路径 |
| `apps/server-agent/src/controllers/session.controller.ts` | `POST :id/retry` |
| `apps/web-agent/src/rest/session.ts` | `retrySession` 函数 |
| `apps/web-agent/src/app/session/page.tsx` | 去重 + pending 区分区渲染 + 重试 |
| `apps/web-agent/src/components/session/message-list.tsx` | failed 态 + 重试按钮；pending 区 |

---

## Task 1：安装供应商集成包（Bug 1）

**Files:**
- Modify: `libs/agent/package.json`
- Modify (可能): `libs/agent/src/graph/llm.factory.ts`

- [ ] **Step 1: 装包**

`PROVIDERS`（`libs/types-agent/src/ai/providers.ts`）有 6 个 type：`openai` / `anthropic` / `google` / `deepseek` / `ollama` / `openai-compatible`。`openai-compatible` 复用 `@langchain/openai`，其余各装对应包。

Run: `pnpm --filter @meshbot/agent add @langchain/openai @langchain/anthropic @langchain/google-genai @langchain/deepseek @langchain/ollama`
Expect: 5 个包进 `libs/agent/package.json` dependencies。

若某包安装时报与 `@langchain/core@^0.3` 的 peer 冲突，按报错装兼容版本（这些 `@langchain/*` 集成包都声明 `@langchain/core` peer —— 装与 `^0.3` 兼容的版本）。报告实际装的版本。

- [ ] **Step 2: 核对 initChatModel 的 modelProvider 名**

读 `libs/agent/src/graph/llm.factory.ts`。当前 `createChatModel` 调 `initChatModel(config.model, { modelProvider: config.providerType, ... })`。`initChatModel` 期望的 `modelProvider` 字符串是 LangChain 约定的 provider 名 —— 多数与包名后缀一致，但有出入：
- `openai` → modelProvider `"openai"` ✓
- `anthropic` → `"anthropic"` ✓
- `google` → LangChain 用 `"google-genai"`（不是 `"google"`）
- `deepseek` → `"deepseek"` ✓
- `ollama` → `"ollama"` ✓
- `openai-compatible` → 用 `"openai"`（ChatOpenAI + baseUrl）

`ModelConfig.providerType` 存的是 PROVIDERS 的 `type`（`google` / `openai-compatible`）。这两个与 `initChatModel` 期望值不一致。在 `llm.factory.ts` 加一个映射：

```ts
/** PROVIDERS type → initChatModel 期望的 modelProvider 名。 */
const PROVIDER_MODEL_NAME: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google-genai",
  deepseek: "deepseek",
  ollama: "ollama",
  "openai-compatible": "openai",
};
```

`createChatModel` 把 `modelProvider: config.providerType` 改为 `modelProvider: PROVIDER_MODEL_NAME[config.providerType] ?? config.providerType`。

读 `llm.factory.ts` 的实际当前代码，把这个映射加进去（放在文件顶部或函数前）。保留 `streaming: true` 和 baseUrl 透传逻辑不变。

- [ ] **Step 3: 验证 deepseek 能加载**

构建：`pnpm --filter @meshbot/agent build` — expect 无错。

实测 deepseek 集成包能 require（这是 Bug 1 的核心验证）：
Run: `cd libs/agent && node -e "require('@langchain/deepseek'); console.log('@langchain/deepseek OK')" && cd ../..`
Expect: 打印 `@langchain/deepseek OK`（不再 MODULE_NOT_FOUND）。

> 不必真的调 deepseek API（需要 key）。能 `require` 即证明 Bug 1 的 `MODULE_NOT_FOUND` 已解决；`initChatModel` 懒加载的就是这个 require。

- [ ] **Step 4: 提交**

```bash
pnpm format
git add libs/agent/package.json libs/agent/src/graph/llm.factory.ts pnpm-lock.yaml
git commit -m "fix(agent): 安装全部供应商 LLM 集成包修复 deepseek 加载失败

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2：PendingMessageStatus 加 failed + RetryResponse

**Files:**
- Modify: `libs/types-agent/src/session.ts`
- Test: `libs/types-agent/src/session.spec.ts`

- [ ] **Step 1: 写失败测试**

读 `libs/types-agent/src/session.spec.ts`。在其 `describe` 块内追加：

```ts
  it("PendingMessageStatus 包含 failed", () => {
    expect(PendingMessageStatus.options).toEqual([
      "pending",
      "processing",
      "processed",
      "failed",
    ]);
  });

  it("RetryResponseSchema 校验 retried 标志", () => {
    expect(RetryResponseSchema.parse({ retried: true })).toEqual({
      retried: true,
    });
  });
```

确认测试文件顶部 import 含 `PendingMessageStatus` 和 `RetryResponseSchema`（`RetryResponseSchema` 这一步还不存在 —— 加进 import）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/types-agent test -- session.spec`
Expected: FAIL（`failed` 不在枚举 / `RetryResponseSchema` 未定义）

- [ ] **Step 3: 改 session.ts**

`libs/types-agent/src/session.ts`：

`PendingMessageStatus` 从：
```ts
export const PendingMessageStatus = z.enum([
  "pending",
  "processing",
  "processed",
]);
```
改为：
```ts
export const PendingMessageStatus = z.enum([
  "pending",
  "processing",
  "processed",
  "failed",
]);
```

在文件末尾（其他 schema 旁）加 `RetryResponse`：
```ts
/** POST /api/sessions/:id/retry 出参。 */
export const RetryResponseSchema = z.object({
  retried: z.boolean(),
});
export type RetryResponse = z.infer<typeof RetryResponseSchema>;
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/types-agent test -- session.spec`
Expected: PASS

- [ ] **Step 5: 构建**

Run: `pnpm --filter @meshbot/types-agent build` — expect 无错。

- [ ] **Step 6: 提交**

```bash
pnpm format
git add libs/types-agent/src/session.ts libs/types-agent/src/session.spec.ts
git commit -m "feat(types-agent): PendingMessageStatus 加 failed + RetryResponse

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3：GraphService —— streamMessage 带 id + resumeStream

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts`
- Test: `libs/agent/tests/unit/graph.service.test.ts`

`libs/agent` 用 **vitest**。

- [ ] **Step 1: 读现有 graph.service.ts**

`streamMessage` 当前签名 `streamMessage(threadId, message: string, signal)`，内部 `inputMessages.push(new HumanMessage(message))`。要改为接受 `{id,content}[]`，每条构造带 id 的 `HumanMessage`。`HumanMessage` 构造支持 `new HumanMessage({ content, id })`（已验证）。再加一个 `resumeStream`。

- [ ] **Step 2: 写失败测试**

在 `libs/agent/tests/unit/graph.service.test.ts` 末尾（`describe` 内）追加。该文件已有 fake model（`stream()` 产 `AIMessageChunk`）。

```ts
  it("streamMessage 用传入 id 构造 HumanMessage 并写入 checkpointer", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    const chunks = [];
    for await (const ev of graphService.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      chunks.push(ev);
    }
    const history = await graphService.getHistory(threadId);
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg?.id).toBe("pm-1");
  });

  it("resumeStream 不加新消息，从现有状态继续流式", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    for await (const _ of graphService.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      // 先跑一轮建立历史
    }
    const before = await graphService.getHistory(threadId);
    const userCountBefore = before.filter((m) => m.role === "user").length;
    const chunks = [];
    for await (const ev of graphService.resumeStream(threadId)) {
      chunks.push(ev);
    }
    const after = await graphService.getHistory(threadId);
    const userCountAfter = after.filter((m) => m.role === "user").length;
    expect(userCountAfter).toBe(userCountBefore);
    expect(chunks.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/agent test -- graph.service`
Expected: FAIL（`streamMessage` 仍要 string / `resumeStream` 不存在）

- [ ] **Step 4: 改 streamMessage 签名 + 加 resumeStream**

`libs/agent/src/graph/graph.service.ts`：

`streamMessage` 改为接受 `{ id: string; content: string }[]`：

```ts
  /**
   * 向会话发送一批消息并逐 token 流式产出 assistant 回复。
   *
   * 每条入参构造一条带显式 id 的 HumanMessage（id = 调用方的 PendingMessage.id），
   * 让 checkpointer 里的 user 消息与 pending 表可对齐去重。
   * system prompt 仅在首轮注入（无历史时）。
   */
  async *streamMessage(
    threadId: ThreadId,
    inputs: { id: string; content: string }[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    this.promptService.reloadIfChanged();
    const systemPrompt = this.promptService.getPrompt("system");
    const state = await this.graph.getState({
      configurable: { thread_id: threadId },
    });
    const hasHistory =
      Array.isArray((state.values as GraphState)?.messages) &&
      (state.values as GraphState).messages.length > 0;
    const inputMessages: BaseMessage[] = [];
    if (systemPrompt && !hasHistory) {
      inputMessages.push(new SystemMessage(systemPrompt));
    }
    for (const input of inputs) {
      inputMessages.push(
        new HumanMessage({ content: input.content, id: input.id }),
      );
    }
    yield* this.runGraphStream(threadId, { messages: inputMessages }, signal);
  }

  /**
   * 不加新消息，从 checkpointer 现有状态恢复并流式产出 assistant 回复。
   *
   * 用于重试 —— failed 消息的 HumanMessage 已在会话里（最后一条），
   * 重试只让 graph 基于现有状态重跑产出回复。
   */
  async *resumeStream(
    threadId: ThreadId,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    this.promptService.reloadIfChanged();
    yield* this.runGraphStream(threadId, null, signal);
  }

  /** 执行 graph.stream 并把 AIMessageChunk 逐个 yield 成 StreamChunk。 */
  private async *runGraphStream(
    threadId: ThreadId,
    input: { messages: BaseMessage[] } | null,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const stream = await this.graph.stream(input, {
      configurable: { thread_id: threadId },
      streamMode: "messages",
      signal,
    });
    for await (const part of stream) {
      // streamMode:"messages" 产出 [BaseMessage, metadata] 元组
      const msg = Array.isArray(part) ? part[0] : part;
      if (!(msg instanceof AIMessageChunk)) continue;
      const delta = typeof msg.content === "string" ? msg.content : "";
      if (!delta) continue;
      yield { messageId: msg.id ?? randomUUID(), delta };
    }
  }
```

注意：把原 `streamMessage` 里 `for await (const part of stream)` 那段抽成 `runGraphStream` 私有方法（`streamMessage` 和 `resumeStream` 共用）。读实际现有代码 —— 原 `streamMessage` 后半段的 stream 迭代逻辑原样搬进 `runGraphStream`，保持 `Array.isArray(part)` 元组处理、空 delta 跳过、`msg.id ?? randomUUID()` 不变。

`graph.stream(null, config)` —— LangGraph 的「从 checkpoint 恢复、不加新输入」。**实施检查点**：验证 `@langchain/langgraph@0.2` 接受 `null` 作为 input。若 TS 类型不允许 `null`，试 `graph.stream(null as never, ...)` 或查该版本对「resume」的正确调用（可能是不带 messages 的空对象 `{}`，但 `{}` 可能被 reducer 当空批次；`null` 是标准的 resume 信号）。若 `null` 运行时不工作，报告并用该版本的等价 resume 机制。

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/agent test -- graph.service`
Expected: PASS。若 fake model 的 `getHistory` 拿不到带 id 的 user 消息，检查 fake 是否如实经过 checkpointer —— graph.service.test.ts 的 fake 是真 graph + fake model，HumanMessage 会真的进 checkpointer，`getHistory` 能读到。

- [ ] **Step 6: 全量 agent 测试 + 构建**

Run: `pnpm --filter @meshbot/agent test && pnpm --filter @meshbot/agent build`
Expected: 全 PASS，构建无错。

> 注意：`streamMessage` 签名变了（string → 数组），`RunnerService`（apps/server-agent）调用它的地方会编译失败 —— 那是 Task 5 修。本 Task 只保证 `libs/agent` 自身测试 + 构建通过。`apps/server-agent` 的构建失败在 Task 5 前是预期的。

- [ ] **Step 7: 提交**

```bash
pnpm format
git add libs/agent/src/graph/graph.service.ts libs/agent/tests/unit/graph.service.test.ts
git commit -m "feat(agent): streamMessage 带 id 批次 + 新增 resumeStream

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4：SessionService —— markFailed + claimFailed + listActivePending 含 failed

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`

- [ ] **Step 1: 写失败测试**

读 `apps/server-agent/src/services/session.service.spec.ts`。在 `describe` 块内追加：

```ts
  it("markFailed 把消息标 failed", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markFailed(claimed.map((m) => m.id));
    const active = await service.listActivePending(sessionId);
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe("failed");
  });

  it("listActivePending 包含 failed 状态消息", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markFailed(claimed.map((m) => m.id));
    const active = await service.listActivePending(sessionId);
    expect(active.some((m) => m.status === "failed")).toBe(true);
  });

  it("claimFailed 把 failed 消息批量转 processing 并返回", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markFailed(claimed.map((m) => m.id));
    const reclaimed = await service.claimFailed(sessionId);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].status).toBe("processing");
    const active = await service.listActivePending(sessionId);
    expect(active.every((m) => m.status === "processing")).toBe(true);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- session.service`
Expected: FAIL（`markFailed` / `claimFailed` 不存在）

- [ ] **Step 3: 改 session.service.ts**

`apps/server-agent/src/services/session.service.ts`：

`listActivePending` —— `where` 数组加 `failed`：
```ts
  /** 列出会话下排队/处理/失败中的消息，按时间升序。 */
  listActivePending(sessionId: string): Promise<PendingMessage[]> {
    return this.pendingRepo.find({
      where: [
        { sessionId, status: "pending" },
        { sessionId, status: "processing" },
        { sessionId, status: "failed" },
      ],
      order: { createdAt: "ASC" },
    });
  }
```

新增 `markFailed`（放在 `markProcessed` 旁）：
```ts
  /** 把一批消息标记为 failed（run 出错时调用；HumanMessage 已在 checkpointer）。 */
  async markFailed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pendingRepo.update({ id: In(ids) }, { status: "failed" });
  }
```

新增 `claimFailed`（仿 `claimPending`，放在它旁边）：
```ts
  /**
   * 取会话全部 failed 消息，整批转 processing 后返回（用于重试）。
   * 这些消息的 HumanMessage 已在 checkpointer，重试只重跑产出回复。
   */
  async claimFailed(sessionId: string): Promise<PendingMessage[]> {
    const rows = await this.pendingRepo.find({
      where: { sessionId, status: "failed" },
      order: { createdAt: "ASC" },
    });
    if (rows.length === 0) return [];
    await this.pendingRepo.update(
      { id: In(rows.map((r) => r.id)) },
      { status: "processing" },
    );
    return rows.map((r) => ({ ...r, status: "processing" as const }));
  }
```

`rollbackToPending` 保留不动（Task 5 的 runOnce 不再用它，但启动恢复 `rollbackProcessingToPending` 仍在 —— 不删）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- session.service`
Expected: PASS

- [ ] **Step 5: 围栏**

Run: `pnpm check`
Expected: 6 围栏 0 finding。`markFailed`/`claimFailed` 是单表 update，非 `@Transactional`，名字不命中事务后缀 —— `check:tx`/`check:naming` 不报。

- [ ] **Step 6: 提交**

```bash
pnpm format
git add apps/server-agent/src/services/session.service.ts apps/server-agent/src/services/session.service.spec.ts
git commit -m "feat(session): SessionService 新增 markFailed / claimFailed

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5：RunnerService —— 带 id 批次 + 出错标 failed + 重试 run

**Files:**
- Modify: `apps/server-agent/src/services/runner.service.ts`
- Test: `apps/server-agent/src/services/runner.service.spec.ts`

- [ ] **Step 1: 写失败测试**

读 `apps/server-agent/src/services/runner.service.spec.ts`。它有 `fakeSessionService` 和 `fakeGraphService`。需要给两个 fake 加方法。

在 `fakeSessionService` 工厂里加 `markFailed` 和 `claimFailed`（仿现有 `markProcessed`/`claimPending`）：
```ts
    async markFailed(ids: string[]) {
      for (const m of store) if (ids.includes(m.id)) m.status = "failed";
    },
    async claimFailed(sessionId: string) {
      const rows = store.filter(
        (m) => m.sessionId === sessionId && m.status === "failed",
      );
      for (const r of rows) r.status = "processing";
      return rows;
    },
```

在 `fakeGraphService` 里：现有 `streamMessage` 现在收数组 —— 改其签名为接受 `inputs` 参数（fake 内部不需要真用它，只要签名兼容）；加 `resumeStream`：
```ts
function fakeGraphService(opts?: { throwErr?: boolean }) {
  return {
    async *streamMessage() {
      if (opts?.throwErr) throw new Error("llm boom");
      yield { messageId: "msg-1", delta: "你" };
      yield { messageId: "msg-1", delta: "好" };
    },
    async *resumeStream() {
      if (opts?.throwErr) throw new Error("llm boom");
      yield { messageId: "msg-r", delta: "重" };
      yield { messageId: "msg-r", delta: "试" };
    },
  };
}
```

加测试用例（在 `describe` 内）：
```ts
  it("出错时标 failed（不回滚 pending）", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService({ throwErr: true }) as never,
      emitter,
    );
    await runner.kickAndWait("s1");
    expect(sess.store[0].status).toBe("failed");
  });

  it("kickRetry：把 failed 消息重跑成 processed", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    sess.enqueue("s1", "hi");
    sess.store[0].status = "failed";
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
    );
    await runner.kickRetryAndWait("s1");
    expect(sess.store[0].status).toBe("processed");
  });
```

同时：现有测试里若有断言「出错回滚 pending」的用例（Task 7 之前写的 `出错时发 run.error 并把消息退回 pending`），改其断言 —— 出错现在标 `failed` 不是 `pending`。把那个用例的 `expect(sess.store[0].status).toBe("pending")` 改为 `toBe("failed")`，或直接用上面新的「出错时标 failed」用例替换它（避免重复）。读实际 spec 文件处理。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- runner.service`
Expected: FAIL（`kickRetryAndWait` 不存在 / 出错断言不符）

- [ ] **Step 3: 改 runner.service.ts**

读 `apps/server-agent/src/services/runner.service.ts` 全文。改动：

**(a) `runOnce` 传带 id 的批次、出错标 failed。** 当前：
```ts
    const ids = batch.map((m) => m.id);
    const input = batch.map((m) => m.content).join("\n");
    ...
      for await (const chunk of this.graph.streamMessage(
        sessionId, input, run.abort.signal,
      )) {
```
改为传 `batch`（`{id,content}[]`）给 `streamMessage`：
```ts
    const ids = batch.map((m) => m.id);
    ...
      for await (const chunk of this.graph.streamMessage(
        sessionId,
        batch.map((m) => ({ id: m.id, content: m.content })),
        run.abort.signal,
      )) {
```
（去掉 `const input = ... join("\n")`。）

错误分支：当前非中断错误 `await this.sessions.rollbackToPending(ids)` 改为 `await this.sessions.markFailed(ids)`。`runError` 事件、`throw err` 保持。中断分支不变。

**(b) `runOnce` 改成能跑「新消息」和「重试」两种。** 新增一个参数或区分入口。最简洁：抽一个私有 `streamRun(sessionId, kind)`，或给 `runOnce` 加一个 `mode: "new" | "resume"` 参数。推荐做法 —— 让 `runOnce` 接受一个「如何取流」的回调或 mode。具体：

把 `runOnce` 改为接受 batch + 一个 `resume: boolean`：
```ts
  private async runOnce(
    sessionId: string,
    batch: { id: string; content: string }[],
    resume: boolean,
  ): Promise<void> {
    const ids = batch.map((m) => m.id);
    const run: InflightRun = {
      messageId: null, content: "", status: "streaming",
      abort: new AbortController(),
    };
    this.inflight.set(sessionId, run);
    try {
      const stream = resume
        ? this.graph.resumeStream(sessionId, run.abort.signal)
        : this.graph.streamMessage(
            sessionId,
            batch.map((m) => ({ id: m.id, content: m.content })),
            run.abort.signal,
          );
      for await (const chunk of stream) {
        run.messageId = chunk.messageId;
        run.content += chunk.delta;
        this.emitter.emit(SESSION_WS_EVENTS.runChunk, {
          sessionId, messageId: chunk.messageId, delta: chunk.delta,
        });
      }
      run.status = "done";
      await this.sessions.markProcessed(ids);
      if (run.messageId) {
        this.emitter.emit(SESSION_WS_EVENTS.runDone, {
          sessionId, messageId: run.messageId, content: run.content,
        });
      }
    } catch (err) {
      if (run.abort.signal.aborted) {
        run.status = "interrupted";
        this.emitter.emit(SESSION_WS_EVENTS.runInterrupted, {
          sessionId, messageId: run.messageId ?? "",
        });
      } else {
        await this.sessions.markFailed(ids);
        this.emitter.emit(SESSION_WS_EVENTS.runError, {
          sessionId, messageId: run.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    } finally {
      this.inflight.delete(sessionId);
    }
  }
```

读实际现有 `runOnce` 保持其它细节（JSDoc 更新为提到 resume / failed）。

**(c) `kickAndWait` 的 `runOnce` 调用加 `false`。** 当前 `await this.runOnce(sessionId, batch)` → `await this.runOnce(sessionId, batch, false)`。

**(d) 新增 `kickRetry` + `kickRetryAndWait`。** 仿 `kick`/`kickAndWait`：
```ts
  /** 启动重试消费（fire-and-forget）。重试 failed 消息。 */
  kickRetry(sessionId: string): void {
    if (this.running.has(sessionId)) return;
    void this.kickRetryAndWait(sessionId).catch((err) => {
      this.logger.error(`retry loop crashed for ${sessionId}`, err);
    });
  }

  /** 重试消费循环：取 failed 消息 → resume run。测试直接 await。 */
  async kickRetryAndWait(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);
    await this.sessions.setStatus(sessionId, "running");
    try {
      while (true) {
        const batch = await this.sessions.claimFailed(sessionId);
        if (batch.length === 0) break;
        try {
          await this.runOnce(sessionId, batch, true);
        } catch (err) {
          this.logger.warn(`retry runOnce 失败：${sessionId}`, err);
          break;
        }
      }
    } finally {
      this.running.delete(sessionId);
      await this.sessions.setStatus(sessionId, "idle");
    }
  }
```

读实际 `kickAndWait` 对齐其结构（`running` Set guard、`setStatus`、try/finally、内层 try/catch break —— Task 7 的修复都要保留）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- runner.service`
Expected: PASS

- [ ] **Step 5: 构建 + 围栏**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check`
Expected: 构建无错（Task 3 改的 `streamMessage` 签名现在被正确调用），6 围栏 0 finding。

- [ ] **Step 6: 提交**

```bash
pnpm format
git add apps/server-agent/src/services/runner.service.ts apps/server-agent/src/services/runner.service.spec.ts
git commit -m "feat(session): RunnerService 传 id 批次 + 出错标 failed + 重试 run

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6：SessionController —— POST /api/sessions/:id/retry + pending 含 failed

**Files:**
- Modify: `apps/server-agent/src/controllers/session.controller.ts`
- Test: `apps/server-agent/test/e2e/session.e2e.spec.ts`

- [ ] **Step 1: 加 retry 端点**

读 `apps/server-agent/src/controllers/session.controller.ts`。它有 `create` / `append` / `history` / `pending` 四个端点。加第五个：

```ts
  /** 重试该会话所有失败消息：failed → processing → resume run。 */
  @Post(":id/retry")
  async retry(@Param("id") id: string): Promise<{ retried: boolean }> {
    await this.sessions.findSessionOrFail(id);
    const failed = await this.sessions.listActivePending(id);
    const hasFailed = failed.some((m) => m.status === "failed");
    if (hasFailed) {
      this.runner.kickRetry(id);
    }
    return { retried: hasFailed };
  }
```

> `pending` 端点（`GET :id/pending`）当前 `listActivePending` 返回的列表 —— Task 4 已让 `listActivePending` 含 `failed`，所以 `pending` 端点自动开始返回 failed 消息，无需改 controller 的 `pending` 方法。确认 `pending` 方法体只是 `listActivePending` + 映射，map 里 `status` 字段透传 —— `failed` 会自然带出。读实际代码确认；若 `pending` 方法对 status 做了枚举收窄需放开。

- [ ] **Step 2: 加 e2e 测试**

读 `apps/server-agent/test/e2e/session.e2e.spec.ts`。在 `describe` 内加一个 retry 端点的 happy-path 用例：

```ts
  it("POST /api/sessions/:id/retry 无 failed 消息返回 retried:false", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "retry 测试" });
    const res = await request(app.getHttpServer())
      .post(`/api/sessions/${created.body.sessionId}/retry`)
      .expect(201);
    expect(res.body.retried).toBe(false);
  });
```

> 新建的 session 没有 failed 消息（首条是 pending），所以 `retried:false`。要测 `retried:true` 需要先制造 failed 状态 —— 在 e2e 里制造 failed 比较绕（要让 run 真失败），happy-path 的 `false` 分支 + Task 5 的 `kickRetryAndWait` 单测已覆盖重试逻辑。`true` 分支留给手动冒烟。

- [ ] **Step 3: 运行 e2e**

Run: `pnpm test -- session.e2e`
Expected: PASS（原有 + 新增 retry 用例）

- [ ] **Step 4: 构建 + 围栏**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check`
Expected: 构建无错；6 围栏 0 finding（`check:repo` 确认 Controller 没注入 Repo）。

- [ ] **Step 5: 提交**

```bash
pnpm format
git add apps/server-agent/src/controllers/session.controller.ts apps/server-agent/test/e2e/session.e2e.spec.ts
git commit -m "feat(session): SessionController 新增 POST :id/retry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7：前端 —— retry REST + 去重分区渲染 + 重试按钮

**Files:**
- Modify: `apps/web-agent/src/rest/session.ts`
- Modify: `apps/web-agent/src/components/session/message-list.tsx`
- Modify: `apps/web-agent/src/app/session/page.tsx`

无单测（前端无单测惯例，build + 冒烟为准）。

- [ ] **Step 1: rest/session.ts 加 retrySession**

`apps/web-agent/src/rest/session.ts` 末尾加：

```ts
/** 重试会话失败消息。 */
export async function retrySession(
  sessionId: string,
): Promise<{ retried: boolean }> {
  const { data } = await apiClient.post<{ retried: boolean }>(
    `/api/sessions/${sessionId}/retry`,
    {},
  );
  return data;
}
```

（`apiClient` 已统一解包 envelope —— `data` 直接是 `{ retried }`。）

- [ ] **Step 2: message-list.tsx —— failed 态 + 重试按钮 + pending 区**

读 `apps/web-agent/src/components/session/message-list.tsx`。当前 `TimelineMessage` 有 `pending?` / `streaming?`。加 `failed?: boolean` 和一个 `onRetry?` 回调。

`TimelineMessage` 接口加 `failed?: boolean`。`MessageList` 的 props 加 `onRetry?: () => void`。渲染时:
- `m.failed` 的气泡显示「失败」标记 + 一个「重试」按钮（点击调 `onRetry`）。
- 现有 `m.pending`（排队中）/ `m.streaming` 渲染不变。

具体 JSX：在气泡内 `m.streaming` / `m.pending` 的条件渲染旁加：
```tsx
            {m.failed && (
              <span className="ml-2 text-xs text-destructive">
                失败
                <button
                  type="button"
                  onClick={onRetry}
                  className="ml-1 underline hover:text-destructive/80"
                >
                  重试
                </button>
              </span>
            )}
```
读实际现有 message-list.tsx 的结构，把 `failed` 分支加进与 `pending`/`streaming` 同级的位置。`onRetry` 从 props 接入。

> pending 区的「分区」由会话页 `page.tsx` 决定（它把消息分成两个 `MessageList` 或两个区域渲染）—— `MessageList` 本身只管渲染给它的那批消息。下一步处理分区。

- [ ] **Step 3: page.tsx —— 去重 + pending 区 + 重试**

读 `apps/web-agent/src/app/session/page.tsx`。当前它把 `history.messages` + `inflight` + `pending` 全拼进一个 `messages` 数组给一个 `MessageList`。改为**两个区域**：

(a) **去重**：构建主时间线时，`pending` 列表里 id 已在 `history.messages` 的，不进主时间线的独立气泡 —— 但其 `failed` 状态要叠加到 history 里那条同 id 的 user 消息上。

(b) **分区**：
- 主时间线 = `history.messages`（含 user + assistant）+ inflight assistant。其中 history 里的 user 消息，若对应 pending 表里同 id 的状态是 `failed`，该气泡标 `failed`。
- pending 区 = `pending` 列表里 **id 不在 `history.messages`** 的消息（纯排队中、还没进 checkpointer 的）。

渲染两个 `MessageList`：主时间线在中间可滚动区，pending 区在 `ChatInput` 正上方。

具体改 `SessionView`：
- 把当前的单一 `messages` state 拆开或在渲染时分流。最简洁：保留收集逻辑，但渲染时计算两个数组：
  ```tsx
  const historyIds = new Set(timeline.filter(m => fromHistory).map(m => m.id));
  // pending 区：pending 消息中 id 不在 history 的
  const queuedMessages = pendingItems.filter(p => !historyIds.has(p.id));
  // 主时间线：history 消息 + inflight；failed 状态叠加
  ```
  读实际 page.tsx 的 state 结构（它有 `messagesRef` + `apply`），按其模式实现。核心：`fetchHistory` + `fetchPending` 后，pending 里 id 已在 history 的 → 只用来给主时间线对应气泡打 `failed`/`processing` 标记；id 不在 history 的 → 进 `queuedMessages`。
- JSX：
  ```tsx
      <div className="flex w-full max-w-[620px] flex-1 flex-col">
        <MessageList messages={timelineMessages} onRetry={handleRetry} />
        <div ref={bottomRef} />
      </div>
      <div className="sticky bottom-4 mt-auto bg-background pt-4">
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <MessageList messages={queuedMessages} />
          </div>
        )}
        <ChatInput onSend={handleSend} onInterrupt={handleInterrupt} isLoading={running} />
      </div>
  ```
- `handleRetry`:
  ```tsx
  const handleRetry = useCallback(async () => {
    if (!sessionId) return;
    try {
      await retrySession(sessionId);
    } catch (err) {
      console.error("重试失败", err);
    }
  }, [sessionId]);
  ```
  导入 `retrySession` from `@/rest/session`。
- socket `run.error` handler：现在要把对应主时间线 user 气泡标 `failed`（按 `messageId` 找）。当前 `run.error` handler 是 append 一个错误气泡 —— 改为：找到 `messageId` 对应的 user 气泡，标 `failed: true`。读实际现有 `run.error` handler，调整。`run.chunk`/`run.done` 不变。

> 这一步是本 plan 最灵活的一块 —— 必须读 `page.tsx` 实际代码（它经过 Task 12 的多次修订，有 `messagesRef`/`apply`/`upsertChunk`）按其现有模式改。核心目标：(1) 两个渲染区域；(2) pending 里 id 已在 history 的不重复显示；(3) failed 气泡带重试。保持已有的 socket 流式、自动滚动、merge-on-history-settle 逻辑不破坏。

- [ ] **Step 4: 构建**

Run: `pnpm --filter @meshbot/web-agent build`
Expected: 构建成功（静态导出）。

- [ ] **Step 5: 提交**

```bash
pnpm format
git add apps/web-agent/src/rest/session.ts apps/web-agent/src/components/session/message-list.tsx apps/web-agent/src/app/session/page.tsx
git commit -m "feat(web-session): 会话页消息去重分区 + failed 重试

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8：全量回归 + 端到端冒烟

**Files:** 无（验证 Task）

- [ ] **Step 1: 全量回归**

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @meshbot/agent test
pnpm check
```
Expected：全绿。读完整输出，不被 tail / turbo 退出码掩盖失败（`Test Suites: M failed` 矛盾态要抓出来）。

- [ ] **Step 2: 端到端冒烟**

需 server-agent + web-agent 跑起来 + 已配置 deepseek ModelConfig（含真实 key）+ 已登录。
```
pnpm dev:server-agent
pnpm dev:web-agent
```

验证三条：
1. **Bug 1 修复** — 首页发送消息 → agent 流式回复成功（server-agent 日志不再有 `Cannot find module '@langchain/deepseek'`）。
2. **Bug 2 修复** — 发送后会话页**只显示一个**用户气泡(不再重复)。run 进行中:排队中的消息在输入框上方的 pending 区;被处理的进主时间线。
3. **重试** — 若 run 失败(可临时填错 key 制造失败),失败消息在主时间线显示「失败 + 重试」;点重试 → 重新跑。

报告三条冒烟结果。若任一不符,报告 BLOCKED + 现象。

- [ ] **Step 3: 提交（若冒烟暴露需修的小问题）**

若 Step 2 暴露问题,修复后提交。冒烟全过则本 Task 无提交。

---

## 完成标准

- deepseek（及其他 PROVIDERS 供应商）LLM 集成包已装,`initChatModel` 能加载（Bug 1）
- run 出错时 HumanMessage 留 checkpointer、消息标 `failed`,不再与 pending 双计；`PendingMessage.id` = `HumanMessage.id`
- 会话页按 id 去重:已处理消息只在主时间线、未处理消息在输入框上方 pending 区,无重复气泡（Bug 2）
- `failed` 消息可经 `POST /api/sessions/:id/retry` 重试,resume run 不重写 HumanMessage
- `pnpm typecheck` / `build` / `test` / `pnpm --filter @meshbot/agent test` / `pnpm check` 全绿
