# 会话上下文压缩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 长会话接近模型上下文窗口（≥ 90%）时自动同步压缩历史 messages 到约 20%，并把进度环的数据源改为「下次请求 token / ctx 上限」。

**Architecture:** 触发点放 `runner.runOnce` 顶部 pre-check（同步等待压缩完成才发 LLM 请求）；压缩 = LLM summarize 旧对话 → `graph.updateState(RemoveMessage[] + SystemMessage)` 一次性改写 checkpointer；UI 时间线（session_messages）不删，append 一行 `kind=compaction` 占位；LLM 真实抛 `context_length_exceeded` 时 runner 强制压缩 + 重试一次兜底。

**Tech Stack:** NestJS / TypeORM / LangGraph (SqliteSaver checkpointer) / EventEmitter2 / SQLite / Next.js + jotai + WebSocket。Spec：[docs/superpowers/specs/2026-05-26-context-compaction-design.md](../specs/2026-05-26-context-compaction-design.md)

---

## 文件结构

| 文件 | 类型 | 职责 |
|------|------|------|
| `libs/types-agent/src/session.ts` | 改 | 加 3 个 WS 事件名 + 对应 zod schema/types；`SessionTotalsSchema` 加 `lastInputTokens` |
| `libs/agent/src/prompt/compactor.prompt.ts` | 新 | `COMPACTION_SYSTEM_PROMPT` 常量 |
| `libs/agent/src/index.ts` | 改 | export prompt 常量 |
| `libs/agent/src/graph/graph.service.ts` | 改 | 公开 `getMessagesSnapshot` / `summarize` / `applyCompaction` 三个方法 |
| `libs/agent/src/graph/graph.service.spec.ts` | 改 | 三个方法的 vitest 单测 |
| `apps/server-agent/src/migrations/1779700000000-AddSessionMessagesMetadata.ts` | 新 | `ALTER TABLE session_messages ADD COLUMN metadata TEXT NULL` |
| `apps/server-agent/src/entities/session-message.entity.ts` | 改 | 加 `metadata: string | null` 列映射 |
| `apps/server-agent/src/services/session-message.service.ts` | 改 | 加 `recordCompactionPlaceholder` 方法 |
| `apps/server-agent/src/services/session-message.service.spec.ts` | 新/改 | recordCompactionPlaceholder 单测 |
| `apps/server-agent/src/services/llm-call.service.ts` | 改 | `getSessionTotals` 加 `lastInputTokens`；新增 `getLastBySession` |
| `apps/server-agent/src/services/llm-call.service.spec.ts` | 改 | 新行为单测 |
| `apps/server-agent/src/services/context-compactor.utils.ts` | 新 | 纯函数 `estimateTokens` / `findSplitIndex` / `expandToToolBoundary` / `serializeForSummary` / `isContextLengthError` |
| `apps/server-agent/src/services/context-compactor.utils.spec.ts` | 新 | 上述纯函数单测 |
| `apps/server-agent/src/services/context-compactor.service.ts` | 新 | `ContextCompactor` 入口：锁 + 调度 + 失败处理 |
| `apps/server-agent/src/services/context-compactor.service.spec.ts` | 新 | Nest Testing 集成单测 |
| `apps/server-agent/src/services/runner.service.ts` | 改 | runOnce 顶部 pre-check + streamMessage catch ctx_exceeded 走兜底 |
| `apps/server-agent/src/services/runner.service.spec.ts` | 改/新 | pre-check + 兜底 单测 |
| `apps/server-agent/src/app.module.ts` | 改 | 注册 `ContextCompactor` 到 providers |
| `apps/server-agent/src/types-agent/session.ts` | 改 | types-agent SessionTotals 加字段后，rest 类型同步 |
| `apps/web-agent/src/atoms/session-usage.ts` | 改 | `SessionTotals` atom 扩字段 |
| `apps/web-agent/src/components/common/chat-input.tsx` | 改 | 进度环 `current` 改 `lastInputTokens`；breakdown 多一项「累计 input」 |
| `apps/web-agent/src/app/session/page.tsx` | 改 | 订阅 3 个新 WS 事件，维护 `compacting` 状态 + 顶部 banner；compaction 占位行接入消息列表 |
| `apps/web-agent/src/components/session/compaction-row.tsx` | 新 | 时间线压缩占位行（可展开摘要） |
| `apps/web-agent/src/components/session/message-list.tsx` | 改 | 识别 `metadata.kind=compaction` 时渲染 `CompactionRow` 代替普通系统消息 |
| `apps/web-agent/src/components/common/compaction-banner.tsx` | 新 | session 顶部 banner，受 `compacting` 控制 |
| `apps/web-agent/messages/zh.json` | 改 | 加压缩相关 i18n 文案 |
| `apps/web-agent/messages/en.json` | 改 | 同上 |

---

## Task 1: types-agent 加 WS 事件 + lastInputTokens

**Files:**
- Modify: `libs/types-agent/src/session.ts`
- Modify: `libs/types-agent/src/session.spec.ts`（如存在则在末尾补；不存在则跳过 spec）

- [ ] **Step 1: 写失败测试 —— 新事件 schema 解析**

`libs/types-agent/src/session.spec.ts` 在文件末尾追加：

```ts
import {
  RunCompactionStartEventSchema,
  RunCompactionDoneEventSchema,
  RunCompactionErrorEventSchema,
  SessionTotalsSchema,
  SESSION_WS_EVENTS,
} from "./session";

describe("Context compaction WS events", () => {
  it("RunCompactionStartEvent: reason 必须是 threshold 或 ctx-exceeded", () => {
    expect(
      RunCompactionStartEventSchema.parse({
        sessionId: "s1",
        reason: "threshold",
      }),
    ).toEqual({ sessionId: "s1", reason: "threshold" });
    expect(() =>
      RunCompactionStartEventSchema.parse({ sessionId: "s1", reason: "bogus" }),
    ).toThrow();
  });

  it("RunCompactionDoneEvent 含 removedCount + summaryPreview", () => {
    const v = RunCompactionDoneEventSchema.parse({
      sessionId: "s1",
      removedCount: 12,
      summaryPreview: "用户问了酒店评价…",
    });
    expect(v.removedCount).toBe(12);
  });

  it("RunCompactionErrorEvent 仅 sessionId + error 字符串", () => {
    expect(
      RunCompactionErrorEventSchema.parse({ sessionId: "s1", error: "timeout" }),
    ).toEqual({ sessionId: "s1", error: "timeout" });
  });

  it("SESSION_WS_EVENTS 包含三个 compaction 事件名", () => {
    expect(SESSION_WS_EVENTS.runCompactionStart).toBe("run.compaction_start");
    expect(SESSION_WS_EVENTS.runCompactionDone).toBe("run.compaction_done");
    expect(SESSION_WS_EVENTS.runCompactionError).toBe("run.compaction_error");
  });

  it("SessionTotalsSchema 含 lastInputTokens 字段", () => {
    const t = SessionTotalsSchema.parse({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      callCount: 1,
      lastInputTokens: 100,
    });
    expect(t.lastInputTokens).toBe(100);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/grant/Meta1/meshbot
pnpm test -- --testPathPatterns=libs/types-agent/src/session 2>&1 | tail -20
```

Expected: FAIL，`RunCompactionStartEventSchema` 等未导出 + `SessionTotalsSchema` 没 lastInputTokens

- [ ] **Step 3: 实现 —— 加事件 schema 与扩展 SessionTotalsSchema**

在 `libs/types-agent/src/session.ts` 现有 `SessionTotalsSchema` 定义处改为：

```ts
/** 会话累计：所有 LLM 调用的求和。 */
export const SessionTotalsSchema = TokenBreakdownSchema.extend({
  callCount: z.number(),
  /** 最近一次 LLM 调用的 input_tokens；空 session = 0。用于进度环显示「下次请求估算 / ctx 上限」。 */
  lastInputTokens: z.number(),
});
export type SessionTotals = z.infer<typeof SessionTotalsSchema>;
```

在 `RunToolCallEndEventSchema` 之后追加：

```ts
/** socket: run.compaction_start —— 压缩开始通知。 */
export const RunCompactionStartEventSchema = z.object({
  sessionId: z.string(),
  /** "threshold" = pre-check 触发；"ctx-exceeded" = LLM 报错后兜底触发。 */
  reason: z.enum(["threshold", "ctx-exceeded"]),
});
export type RunCompactionStartEvent = z.infer<
  typeof RunCompactionStartEventSchema
>;

/** socket: run.compaction_done —— 压缩完成。 */
export const RunCompactionDoneEventSchema = z.object({
  sessionId: z.string(),
  /** 被压缩进摘要的原 messages 条数。 */
  removedCount: z.number(),
  /** 摘要文本的前 200 字预览，便于前端 banner 顺手展示。 */
  summaryPreview: z.string(),
});
export type RunCompactionDoneEvent = z.infer<
  typeof RunCompactionDoneEventSchema
>;

/** socket: run.compaction_error —— 压缩失败。 */
export const RunCompactionErrorEventSchema = z.object({
  sessionId: z.string(),
  error: z.string(),
});
export type RunCompactionErrorEvent = z.infer<
  typeof RunCompactionErrorEventSchema
>;
```

修改 `SESSION_WS_EVENTS` 常量：

```ts
export const SESSION_WS_EVENTS = {
  subscribe: "session.subscribe",
  unsubscribe: "session.unsubscribe",
  interrupt: "session.interrupt",
  titleUpdated: "session.title_updated",
  runHuman: "run.human",
  runReasoning: "run.reasoning",
  runChunk: "run.chunk",
  runDone: "run.done",
  runInterrupted: "run.interrupted",
  runError: "run.error",
  runUsage: "run.usage",
  runToolCallStart: "run.tool_call_start",
  runToolCallProgress: "run.tool_call_progress",
  runToolCallEnd: "run.tool_call_end",
  runCompactionStart: "run.compaction_start",
  runCompactionDone: "run.compaction_done",
  runCompactionError: "run.compaction_error",
} as const;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test -- --testPathPatterns=libs/types-agent/src/session 2>&1 | tail -10
```

Expected: PASS（含新增 5 条用例）

- [ ] **Step 5: typecheck 整库**

```bash
pnpm -r typecheck 2>&1 | tail -8
```

Expected: 全部 Done（types-agent 改字段不会让现有消费方红，因为新增字段且未引用）

- [ ] **Step 6: 格式化 + commit**

```bash
pnpm biome check --write libs/types-agent/src/session.ts libs/types-agent/src/session.spec.ts 2>&1 | tail -3
git add libs/types-agent/src/session.ts libs/types-agent/src/session.spec.ts
git commit -m "$(cat <<'EOF'
feat(types-agent): 加 compaction WS 事件 + SessionTotals.lastInputTokens

为会话上下文压缩特性准备共享类型：

- SESSION_WS_EVENTS 加 runCompactionStart / runCompactionDone /
  runCompactionError 三个事件名
- 对应 zod schema + 类型 export
- SessionTotalsSchema 加 lastInputTokens 字段，供进度环显示
  「下次请求估算 / ctx 上限」

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: libs/agent prompt 模板

**Files:**
- Create: `libs/agent/src/prompt/compactor.prompt.ts`
- Modify: `libs/agent/src/index.ts`

- [ ] **Step 1: 创建 prompt 常量文件**

```ts
// libs/agent/src/prompt/compactor.prompt.ts

/**
 * 会话历史摘要器的 SYSTEM prompt。
 *
 * 设计意图：让 LLM 把"老 messages 数组"压缩成一段第三人称叙述，作为新的
 * SystemMessage 注入 checkpointer，替代被 RemoveMessage 删掉的原 messages。
 * 输出限制在 600 token 以内（由 ContextCompactor 透传 maxTokens=600 兜底）。
 */
export const COMPACTION_SYSTEM_PROMPT = `你是一个会话历史摘要器。
将下面的对话按时间顺序压缩成简要总结，保留：
- 用户的关键意图和约束
- 已尝试过的方法、成功与失败的结果
- 重要的工具调用结论（不要保留截图 / 长输出的原文，仅描述要点）
- 当前进行中的任务状态

不保留：
- 寒暄
- 已被后续轮次推翻或重做的细节
- 工具调用的原始 base64 / 大段日志

输出 600 token 以内，第三人称叙述。`;
```

- [ ] **Step 2: 导出 prompt 常量**

修改 `libs/agent/src/index.ts`，在合适位置加：

```ts
export { COMPACTION_SYSTEM_PROMPT } from "./prompt/compactor.prompt";
```

- [ ] **Step 3: typecheck**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent && pnpm typecheck 2>&1 | tail -5
```

Expected: Done

- [ ] **Step 4: 格式化 + commit**

```bash
cd /Users/grant/Meta1/meshbot
pnpm biome check --write libs/agent/src/prompt/compactor.prompt.ts libs/agent/src/index.ts 2>&1 | tail -3
git add libs/agent/src/prompt/compactor.prompt.ts libs/agent/src/index.ts
git commit -m "$(cat <<'EOF'
feat(agent): 加上下文压缩 SYSTEM prompt 模板

ContextCompactor 调用 graph.summarize 时使用，输出限 600 token 第三人称
叙述。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: GraphService 暴露三个 compaction hook

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts`
- Create: `libs/agent/tests/unit/graph-compaction.test.ts`

新增三个方法（保持 libs/agent 不依赖 ModelConfig / SessionMessage 等 server-agent 实体）：

- `getMessagesSnapshot(threadId): Promise<BaseMessage[]>` — 直接拿 checkpointer state.values.messages
- `summarize(messages: BaseMessage[], opts: { timeoutMs: number; maxTokens: number }): Promise<string>` — 走 `resolveModel()` + system prompt + serialized history → 返回摘要字符串
- `applyCompaction(threadId, params: { removeIds: string[]; summaryText: string }): Promise<void>` — 一次性 `updateState(RemoveMessage[] + SystemMessage)`

`summarize` 内部序列化逻辑由 ContextCompactor 提供（避免 libs/agent 重新发明），所以这里 summarize 接收的就是已 serialize 好的字符串。**调整**：把 summarize 改成接收 `serialized: string` 而不是 BaseMessage[]，让 libs/agent 不需要知道"如何把 messages 拍扁成文本"的策略。

- [ ] **Step 1: 写完整失败测试**

创建 `libs/agent/tests/unit/graph-compaction.test.ts`（沿用既有 graph.service.test.ts 的 fakeModel + 内存 SqliteSaver 模式，加 `invoke` 桩）：

```ts
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { GraphService } from "../../src/graph/graph.service";
import { PromptService } from "../../src/prompt/prompt.service";
import { ToolRegistry } from "../../src/tools/tool-registry";

describe("GraphService compaction hooks", () => {
  let testDir: string;
  let graphService: GraphService;
  let invokeCalls: { messages: { content: string }[]; config: unknown }[];

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-compact-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const configService = new MeshbotConfigService();
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const promptService = new PromptService(testDir);
    invokeCalls = [];
    const fakeModel = {
      stream: async () => {
        async function* gen() {
          yield new AIMessage({ id: "fake-a", content: "stream-ack" });
        }
        return gen();
      },
      invoke: async (messages: { content: string }[], config?: unknown) => {
        invokeCalls.push({ messages, config });
        return new AIMessage({ id: "summary-resp", content: "MOCK_SUMMARY" });
      },
    };
    const toolRegistry = new ToolRegistry({ getProviders: () => [] } as never);
    graphService = new GraphService(
      configService,
      promptService,
      toolRegistry,
      new EventEmitter2(),
      () => Promise.resolve(fakeModel as never),
      { providerType: "fake", model: "fake-model" },
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("getMessagesSnapshot 空 thread 返空数组", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    const msgs = await graphService.getMessagesSnapshot(threadId);
    expect(msgs).toEqual([]);
  });

  it("getMessagesSnapshot 在 streamMessage 后返非空", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    for await (const _ of graphService.streamMessage(threadId, [
      { id: "h1", content: "hi" },
    ])) {
      // drain
    }
    const msgs = await graphService.getMessagesSnapshot(threadId);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("summarize 调 model.invoke 传 system + user 并返字符串", async () => {
    const out = await graphService.summarize(
      "[user] hi\n[assistant] hello",
      { systemPrompt: "SYS", timeoutMs: 1000, maxTokens: 100 },
    );
    expect(out).toBe("MOCK_SUMMARY");
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].messages[0].content).toBe("SYS");
    expect(invokeCalls[0].messages[1].content).toContain("hi");
  });

  it("applyCompaction 删指定 id + 注入新 SystemMessage", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    for await (const _ of graphService.streamMessage(threadId, [
      { id: "h1", content: "hi" },
    ])) {
      // drain
    }
    const before = await graphService.getMessagesSnapshot(threadId);
    const ids = before
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    expect(ids.length).toBeGreaterThan(0);

    await graphService.applyCompaction(threadId, {
      removeIds: ids,
      summaryText: "COMPRESSED_SUMMARY",
    });

    const after = await graphService.getMessagesSnapshot(threadId);
    // 原 messages 已被 RemoveMessage 删，只剩注入的 SystemMessage
    const summaryRows = after.filter(
      (m) =>
        m._getType() === "system" &&
        typeof m.content === "string" &&
        m.content.includes("COMPRESSED_SUMMARY"),
    );
    expect(summaryRows.length).toBe(1);
    // 原 id 应该不在 after 里
    for (const id of ids) {
      expect(after.find((m) => m.id === id)).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent
pnpm exec vitest run tests/unit/graph-compaction.test.ts 2>&1 | tail -10
```

Expected: FAIL（方法不存在或未导出）

- [ ] **Step 3: 实现三个方法**

在 `libs/agent/src/graph/graph.service.ts` `GraphService` 类内，在 `cutMessagesAfter` 方法之后添加：

```ts
/**
 * 拿出 checkpointer 里当前 thread 的 messages 数组快照。
 *
 * 给 ContextCompactor 用于切分计算。返回空数组表示线程没历史。
 */
async getMessagesSnapshot(threadId: ThreadId): Promise<BaseMessage[]> {
  const snapshot = await this.graph.getState({
    configurable: { thread_id: threadId },
  });
  const msgs = (snapshot.values as GraphState | undefined)?.messages;
  return Array.isArray(msgs) ? msgs : [];
}

/**
 * 调摘要 LLM。serialized 已经是拍扁的对话文本（含 [user]/[assistant]/[tool]
 * 前缀、tool result 截断等），由调用方负责。这里只关心把 system prompt +
 * 用户串组合后丢给 enabled model invoke，并截 maxTokens。
 *
 * 用 AbortController 实现 timeoutMs；超时直接抛 Error("Summarize timeout")。
 */
async summarize(
  serialized: string,
  opts: { systemPrompt: string; timeoutMs: number; maxTokens: number },
): Promise<string> {
  const model = await this.resolveModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const resp = await model.invoke(
      [
        new SystemMessage(opts.systemPrompt),
        new HumanMessage(serialized),
      ],
      { signal: controller.signal, maxTokens: opts.maxTokens } as never,
    );
    const content = resp.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一次性 updateState：删 removeIds 指定的 messages + 注入一条新 SystemMessage
 * （内容 = summaryText）。messages reducer 已支持 RemoveMessage 与 append。
 *
 * 注入的 SystemMessage 落在 messages 数组末尾（reducer append 行为），LLM
 * 实际看到的顺序是 [原始 system prompt（首条）] [新摘要 system] [保留区 messages]，
 * 摘要与近期对话相邻，注意力上下文更连贯。
 */
async applyCompaction(
  threadId: ThreadId,
  params: { removeIds: string[]; summaryText: string },
): Promise<void> {
  const ops: BaseMessage[] = params.removeIds.map(
    (id) => new RemoveMessage({ id }),
  );
  ops.push(
    new SystemMessage({
      content: `[Earlier conversation summary]\n${params.summaryText}`,
      id: `compaction-summary-${Date.now()}`,
    }),
  );
  await this.graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: ops },
  );
}
```

需要确认 `BaseMessage` / `RemoveMessage` / `SystemMessage` / `HumanMessage` 已在文件顶部 import；现有代码已 import。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm exec vitest run tests/unit/graph-compaction.test.ts 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: 跑 libs/agent 全量 vitest 防回归**

```bash
pnpm test 2>&1 | tail -8
```

Expected: 新测全过；既有 3 条 graph.service.test 失败是 main 已存在的预存失败，不属于本任务回归

- [ ] **Step 6: 格式化 + commit**

```bash
cd /Users/grant/Meta1/meshbot
pnpm biome check --write libs/agent/src/graph/graph.service.ts libs/agent/tests/unit/graph-compaction.test.ts 2>&1 | tail -3
git add libs/agent/src/graph/graph.service.ts libs/agent/tests/unit/graph-compaction.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): GraphService 暴露 compaction 三个 hook

- getMessagesSnapshot(threadId): 拿 checkpointer state 的 messages 数组
- summarize(serialized, opts): 调 enabled model 跑摘要；含 timeoutMs 与 maxTokens
- applyCompaction(threadId, { removeIds, summaryText }): 一次性 updateState
  完成 RemoveMessage[] + new SystemMessage

ContextCompactor 服务（apps/server-agent）通过这三个口子操作 checkpointer，
保持 libs/agent 跟 ModelConfig / SessionMessage 等业务实体的解耦。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: SessionMessage 加 metadata 列

**Files:**
- Create: `apps/server-agent/src/migrations/1779700000000-AddSessionMessagesMetadata.ts`
- Modify: `apps/server-agent/src/entities/session-message.entity.ts`
- Modify: `apps/server-agent/src/services/session-message.service.ts`
- Create: `apps/server-agent/src/services/session-message.service.spec.ts`（如无）

- [ ] **Step 1: 写 migration**

```ts
// apps/server-agent/src/migrations/1779700000000-AddSessionMessagesMetadata.ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * session_messages 加 metadata 列，存压缩占位行的元信息。
 *
 * SQLite 用 TEXT 存 JSON 字符串。默认 NULL，普通 user/assistant/tool 不写。
 * Compaction 占位行写 { kind: "compaction", removedCount, fromMessageId,
 * toMessageId, summary }。
 */
export class AddSessionMessagesMetadata1779700000000
  implements MigrationInterface
{
  name = "AddSessionMessagesMetadata1779700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_messages" ADD COLUMN "metadata" TEXT NULL`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 DROP COLUMN；保留列即可（参考既有 AddSessionsPinnedAt 注释）
  }
}
```

- [ ] **Step 2: Entity 加列映射**

修改 `apps/server-agent/src/entities/session-message.entity.ts`，在 `toolCallId` 之后追加：

```ts
/**
 * 元信息 JSON 字符串。普通消息为 null。
 *
 * Compaction 占位行内容形如：
 *   { kind: "compaction", removedCount: 12, fromMessageId, toMessageId, summary }
 *
 * 解析责任在调用方（service 读出后 JSON.parse；写入前 JSON.stringify）。
 */
@Column({ type: "text", nullable: true })
metadata!: string | null;
```

- [ ] **Step 3: 写失败测试 —— recordCompactionPlaceholder**

创建 / 在 `apps/server-agent/src/services/session-message.service.spec.ts` 加：

```ts
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { SessionMessage } from "../entities/session-message.entity";
import { SessionMessageService } from "./session-message.service";

describe("SessionMessageService.recordCompactionPlaceholder", () => {
  let service: SessionMessageService;
  let repo: jest.Mocked<Repository<SessionMessage>>;

  beforeEach(async () => {
    repo = {
      findOneBy: jest.fn(),
      insert: jest.fn(),
    } as unknown as jest.Mocked<Repository<SessionMessage>>;
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionMessageService,
        { provide: getRepositoryToken(SessionMessage), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(SessionMessageService);
  });

  it("插入一行 role=system + content=summary + metadata JSON", async () => {
    repo.findOneBy.mockResolvedValue(null);
    await service.recordCompactionPlaceholder({
      id: "comp-1",
      sessionId: "s1",
      summary: "用户问了 X，已尝试 Y",
      removedCount: 5,
      fromMessageId: "m1",
      toMessageId: "m5",
    });
    expect(repo.insert).toHaveBeenCalledTimes(1);
    const arg = repo.insert.mock.calls[0][0] as Partial<SessionMessage>;
    expect(arg.role).toBe("system");
    expect(arg.content).toBe("用户问了 X，已尝试 Y");
    const meta = JSON.parse(arg.metadata as string);
    expect(meta).toEqual({
      kind: "compaction",
      removedCount: 5,
      fromMessageId: "m1",
      toMessageId: "m5",
    });
  });

  it("id 已存在视为幂等成功，不重复 insert", async () => {
    repo.findOneBy.mockResolvedValue({ id: "comp-1" } as SessionMessage);
    await service.recordCompactionPlaceholder({
      id: "comp-1",
      sessionId: "s1",
      summary: "x",
      removedCount: 1,
      fromMessageId: "a",
      toMessageId: "b",
    });
    expect(repo.insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

```bash
cd /Users/grant/Meta1/meshbot
pnpm test -- --testPathPatterns=session-message.service.spec 2>&1 | tail -10
```

Expected: FAIL（方法未定义）

- [ ] **Step 5: 实现 recordCompactionPlaceholder**

在 `apps/server-agent/src/services/session-message.service.ts` `recordToolResult` 之后追加：

```ts
/** 写 compaction 占位行入参。id 调用方自行生成（建议 `comp-${uuid}` 或时间戳）。 */
export interface RecordCompactionPlaceholderInput {
  id: string;
  sessionId: string;
  summary: string;
  removedCount: number;
  fromMessageId: string;
  toMessageId: string;
}

/* … class body … */

/**
 * 写一条 compaction 占位行（role=system，metadata 标 kind=compaction）。
 * 幂等：同 id 已存在直接返回。
 *
 * UI 在 message-list 渲染时识别 metadata.kind === "compaction" 走折叠组件，
 * 不当普通系统消息显示。
 */
async recordCompactionPlaceholder(
  input: RecordCompactionPlaceholderInput,
): Promise<void> {
  const exists = await this.repo.findOneBy({ id: input.id });
  if (exists) return;
  await this.repo.insert({
    id: input.id,
    sessionId: input.sessionId,
    role: "system",
    content: input.summary,
    reasoning: null,
    toolCalls: null,
    toolCallId: null,
    metadata: JSON.stringify({
      kind: "compaction",
      removedCount: input.removedCount,
      fromMessageId: input.fromMessageId,
      toMessageId: input.toMessageId,
    }),
    createdAt: new Date(),
  });
}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
pnpm test -- --testPathPatterns=session-message.service.spec 2>&1 | tail -8
```

Expected: PASS（2 个用例）

- [ ] **Step 7: typecheck**

```bash
pnpm -r typecheck 2>&1 | tail -5
```

Expected: Done

- [ ] **Step 8: 格式化 + commit**

```bash
pnpm biome check --write \
  apps/server-agent/src/migrations/1779700000000-AddSessionMessagesMetadata.ts \
  apps/server-agent/src/entities/session-message.entity.ts \
  apps/server-agent/src/services/session-message.service.ts \
  apps/server-agent/src/services/session-message.service.spec.ts 2>&1 | tail -3
git add apps/server-agent/src/migrations/1779700000000-AddSessionMessagesMetadata.ts \
        apps/server-agent/src/entities/session-message.entity.ts \
        apps/server-agent/src/services/session-message.service.ts \
        apps/server-agent/src/services/session-message.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): session_messages 加 metadata 列 + recordCompactionPlaceholder

- migration 1779700000000 ALTER TABLE 加 metadata TEXT NULL
- Entity 映射新列
- Service 新增 recordCompactionPlaceholder，写 role=system + JSON metadata
  { kind: "compaction", removedCount, fromMessageId, toMessageId }
  幂等（id 已存在直接返回）

为 ContextCompactor 写入压缩占位行做准备。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: LlmCallService.getSessionTotals 加 lastInputTokens + getLastBySession

**Files:**
- Modify: `apps/server-agent/src/services/llm-call.service.ts`
- Modify: `apps/server-agent/src/services/llm-call.service.spec.ts`

- [ ] **Step 1: 写失败测试**

在 `apps/server-agent/src/services/llm-call.service.spec.ts` 末尾追加：

```ts
describe("getSessionTotals lastInputTokens", () => {
  it("空 session 返 lastInputTokens=0", async () => {
    const totals = await service.getSessionTotals("empty-session");
    expect(totals.lastInputTokens).toBe(0);
  });

  it("多条 LlmCall 时 lastInputTokens = 最新 createdAt 那行的 inputTokens", async () => {
    await service.record({
      sessionId: "s1", messageId: "m1", providerType: "x", model: "y",
      inputTokens: 100, outputTokens: 10, totalTokens: 110,
      cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
      durationMs: 100,
    });
    await new Promise((r) => setTimeout(r, 5)); // 保证 createdAt 不同
    await service.record({
      sessionId: "s1", messageId: "m2", providerType: "x", model: "y",
      inputTokens: 250, outputTokens: 20, totalTokens: 270,
      cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
      durationMs: 100,
    });
    const totals = await service.getSessionTotals("s1");
    expect(totals.lastInputTokens).toBe(250);
    expect(totals.inputTokens).toBe(350); // sum 仍正确
    expect(totals.callCount).toBe(2);
  });
});

describe("getLastBySession", () => {
  it("空 session 返 null", async () => {
    expect(await service.getLastBySession("empty")).toBeNull();
  });

  it("有调用时返最新一行", async () => {
    await service.record({
      sessionId: "s2", messageId: "m1", providerType: "x", model: "y",
      inputTokens: 50, outputTokens: 5, totalTokens: 55,
      cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
      durationMs: 10,
    });
    const row = await service.getLastBySession("s2");
    expect(row?.inputTokens).toBe(50);
  });
});
```

> **Note**：如果 spec 文件用 Nest TestingModule + 真实 SQLite repository（如 `data-source.test.ts` pattern），按既有写法；若用 mock repo 则相应改造。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- --testPathPatterns=llm-call.service.spec 2>&1 | tail -10
```

Expected: FAIL（`getLastBySession` 未定义；`getSessionTotals` 返回不含 lastInputTokens）

- [ ] **Step 3: 实现**

修改 `apps/server-agent/src/services/llm-call.service.ts`：

```ts
/** getSessionTotals 返回的会话累计（与 types-agent 的 SessionTotals 同形）。 */
export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  callCount: number;
  /** 最近一次 LLM 调用的 input_tokens；空 session = 0。 */
  lastInputTokens: number;
}
```

`getSessionTotals` 改为：

```ts
async getSessionTotals(sessionId: string): Promise<SessionTotals> {
  const rows = await this.llmCallRepo.find({
    where: { sessionId },
    order: { createdAt: "ASC" },
  });
  const base = rows.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
      reasoningTokens: acc.reasoningTokens + r.reasoningTokens,
      callCount: acc.callCount + 1,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      callCount: 0,
    },
  );
  return {
    ...base,
    lastInputTokens: rows.at(-1)?.inputTokens ?? 0,
  };
}
```

在类末尾追加：

```ts
/** 拿某会话最新一行 LlmCall（按 createdAt 倒序取 1）。供 ContextCompactor pre-check 用。 */
async getLastBySession(sessionId: string): Promise<LlmCall | null> {
  const row = await this.llmCallRepo.findOne({
    where: { sessionId },
    order: { createdAt: "DESC" },
  });
  return row ?? null;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test -- --testPathPatterns=llm-call.service.spec 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: 格式化 + commit**

```bash
pnpm biome check --write apps/server-agent/src/services/llm-call.service.ts apps/server-agent/src/services/llm-call.service.spec.ts 2>&1 | tail -3
git add apps/server-agent/src/services/llm-call.service.ts apps/server-agent/src/services/llm-call.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): LlmCallService 加 lastInputTokens + getLastBySession

- getSessionTotals 多返 lastInputTokens（最近一行的 input_tokens，空 session = 0）
- 新增 getLastBySession 取最新一行 LlmCall

供 ContextCompactor pre-check 判定与前端进度环数据源切换使用。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: ContextCompactor 纯函数工具

**Files:**
- Create: `apps/server-agent/src/services/context-compactor.utils.ts`
- Create: `apps/server-agent/src/services/context-compactor.utils.spec.ts`

- [ ] **Step 1: 写完整失败测试**

```ts
// apps/server-agent/src/services/context-compactor.utils.spec.ts
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  estimateTokens,
  expandToToolBoundary,
  findSplitIndex,
  isContextLengthError,
  serializeForSummary,
} from "./context-compactor.utils";

describe("estimateTokens", () => {
  it("string content：长度 / 4 向上取整", () => {
    const m = new HumanMessage({ id: "h", content: "1234567890" }); // 10 chars
    expect(estimateTokens(m)).toBe(3); // ceil(10/4) = 3
  });

  it("tool_calls 序列化长度参与计算", () => {
    const ai = new AIMessage({
      id: "a",
      content: "",
      tool_calls: [{ id: "t1", name: "bash", args: { cmd: "ls" } }],
    });
    // content 空 + tool_calls JSON 约 50 chars → ~13 tokens
    expect(estimateTokens(ai)).toBeGreaterThan(5);
  });

  it("complex content 数组用 JSON.stringify 估", () => {
    const m = new HumanMessage({
      id: "h",
      content: [{ type: "text", text: "hello" }] as never,
    });
    expect(estimateTokens(m)).toBeGreaterThan(0);
  });
});

describe("findSplitIndex", () => {
  it("全部都在预算内 → 0（保留全部）", () => {
    const msgs = [
      new HumanMessage({ id: "1", content: "hi" }),
      new AIMessage({ id: "2", content: "hello" }),
    ];
    expect(findSplitIndex(msgs, 10_000)).toBe(0);
  });

  it("普通切分：从尾部累加直到超预算", () => {
    const msgs = [
      new HumanMessage({ id: "1", content: "a".repeat(40) }), // ~10 token
      new HumanMessage({ id: "2", content: "b".repeat(40) }), // ~10
      new HumanMessage({ id: "3", content: "c".repeat(40) }), // ~10
    ];
    // budget=15 token：尾部累到 #2（10+10=20 > 15）→ split=2
    expect(findSplitIndex(msgs, 15)).toBe(2);
  });

  it("单条已超预算 → split 落在该条之后（保留它）", () => {
    const msgs = [
      new HumanMessage({ id: "1", content: "a".repeat(40) }),
      new HumanMessage({ id: "2", content: "b".repeat(100) }), // ~25 token
    ];
    expect(findSplitIndex(msgs, 10)).toBe(1);
  });
});

describe("expandToToolBoundary", () => {
  function ai(id: string, calls: { id: string; name: string }[]) {
    return new AIMessage({
      id,
      content: "",
      tool_calls: calls.map((c) => ({ ...c, args: {} })),
    });
  }
  function tool(id: string, callId: string) {
    return new ToolMessage({ id, tool_call_id: callId, content: "result" });
  }

  it("split 干净（无跨界 tool 对）时不动", () => {
    const msgs = [
      ai("a1", [{ id: "t1", name: "x" }]),
      tool("tr1", "t1"),
      new HumanMessage({ id: "h1", content: "next" }),
    ];
    expect(expandToToolBoundary(msgs, 2)).toBe(2);
  });

  it("split 跨开 tool pair：把整对划入 summarize 区", () => {
    const msgs = [
      ai("a1", [{ id: "t1", name: "x" }]),
      tool("tr1", "t1"),
    ];
    // split=1：keep 区是 ToolMessage 但 owner AIMessage 在 summarize 区
    // → 应扩到 2（整对都进 summarize 区）
    expect(expandToToolBoundary(msgs, 1)).toBe(2);
  });

  it("多 tool_calls 一组：全组进 summarize 区", () => {
    const msgs = [
      ai("a1", [
        { id: "t1", name: "x" },
        { id: "t2", name: "y" },
      ]),
      tool("tr1", "t1"),
      tool("tr2", "t2"),
    ];
    expect(expandToToolBoundary(msgs, 1)).toBe(3);
  });
});

describe("serializeForSummary", () => {
  it("普通消息按 role 前缀拼接", () => {
    const out = serializeForSummary([
      new HumanMessage({ id: "h", content: "hi" }),
      new AIMessage({ id: "a", content: "hello" }),
    ]);
    expect(out).toMatch(/\[user\] hi/);
    expect(out).toMatch(/\[assistant\] hello/);
  });

  it("tool result 长内容截断到 500 字 + [truncated N chars]", () => {
    const longResult = "X".repeat(2000);
    const out = serializeForSummary([
      new ToolMessage({ id: "tr1", tool_call_id: "t1", content: longResult }),
    ]);
    expect(out).toContain("[truncated");
    // 截断后整段应远小于 2000
    expect(out.length).toBeLessThan(1000);
  });

  it("tool_calls assistant 输出包含 tool 名 + args", () => {
    const ai = new AIMessage({
      id: "a",
      content: "",
      tool_calls: [{ id: "t1", name: "bash", args: { cmd: "ls -la" } }],
    });
    const out = serializeForSummary([ai]);
    expect(out).toContain("bash");
    expect(out).toMatch(/ls -la|\\"cmd\\"/);
  });
});

describe("isContextLengthError", () => {
  it("OpenAI / DeepSeek 风格 error.code", () => {
    expect(
      isContextLengthError({
        error: { code: "context_length_exceeded" },
      } as never),
    ).toBe(true);
  });

  it("HTTP 400 + message 含 context 字样", () => {
    expect(
      isContextLengthError({
        status: 400,
        message: "context too long",
      } as never),
    ).toBe(true);
  });

  it("Anthropic 风格：prompt is too long", () => {
    expect(
      isContextLengthError({
        error: { type: "invalid_request_error" },
        message: "prompt is too long: 250000 tokens > 200000 maximum",
      } as never),
    ).toBe(true);
  });

  it("Gemini 风格：exceeds the maximum", () => {
    expect(
      isContextLengthError({ message: "input exceeds the maximum" } as never),
    ).toBe(true);
  });

  it("不相关错误返 false", () => {
    expect(isContextLengthError(new Error("network failure"))).toBe(false);
    expect(isContextLengthError({ status: 500 } as never)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- --testPathPatterns=context-compactor.utils 2>&1 | tail -10
```

Expected: FAIL（模块未导出任何函数）

- [ ] **Step 3: 实现纯函数**

```ts
// apps/server-agent/src/services/context-compactor.utils.ts
import type { BaseMessage } from "@langchain/core/messages";

/**
 * 估算单条 message 的 token 占用。
 *
 * 启发式：把 content 主体 + tool_calls 序列化后的字符长度 / 4 向上取整。
 * GPT 系英文约 4 char/token；中文实际 1-2 char/token（偏低估，对预算有利）。
 *
 * **不引入 tiktoken**：各 provider 分词不同，没有统一 JS 库。切分预算估算
 * 偏低对我们有利（实际保留区 token 比预算更少，留有缓冲）。
 */
export function estimateTokens(m: BaseMessage): number {
  const content = m.content;
  const text =
    typeof content === "string" ? content : JSON.stringify(content ?? "");
  const toolCalls = (m as BaseMessage & { tool_calls?: unknown[] }).tool_calls;
  const toolCallsLen = Array.isArray(toolCalls)
    ? JSON.stringify(toolCalls).length
    : 0;
  return Math.ceil((text.length + toolCallsLen) / 4);
}

/**
 * 从尾部往前累加 token，找切分点。
 *
 * 返回的 idx 满足：messages[idx..] 总 token ≤ budget < messages[(idx-1)..]
 * 即 [idx, length) 是「保留区」，[0, idx) 是「待压缩区」。
 * 全部都在预算内时返 0（不压缩任何消息）。
 */
export function findSplitIndex(
  messages: BaseMessage[],
  budget: number,
): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i]);
    if (acc > budget) return i + 1;
  }
  return 0;
}

/**
 * 扩展 splitIdx 到 tool 对的左边界（不切断 tool_call/tool_result pair）。
 *
 * 若 messages[splitIdx] 是孤儿 ToolMessage（其 owner AIMessage 在
 * summarize 区），把 splitIdx 移到 owner 之前，使整对一起进 summarize 区。
 * 循环直到 messages[splitIdx] 不再是孤儿 ToolMessage。
 *
 * 关键性约束：LLM 看到 tool_calls 没对应 ToolMessage（或反过来）会 400。
 * 同款逻辑在 graph.service.sanitizeOrphanToolCalls 验证过。
 */
export function expandToToolBoundary(
  messages: BaseMessage[],
  splitIdx: number,
): number {
  // 限循环次数，防异常数据导致死循环
  for (let safety = 0; safety < messages.length + 1; safety++) {
    if (splitIdx >= messages.length) return splitIdx;
    const right = messages[splitIdx];
    if (right._getType() !== "tool") return splitIdx;
    const toolCallId = (right as BaseMessage & { tool_call_id?: string })
      .tool_call_id;
    if (!toolCallId) return splitIdx;
    // 在 summarize 区找 owner AIMessage
    const ownerIdx = findToolCallOwner(messages, toolCallId, splitIdx);
    if (ownerIdx < 0 || ownerIdx >= splitIdx) return splitIdx;
    // 把 owner 一起划入 summarize 区
    splitIdx = ownerIdx + 1;
    // 接着继续看 messages[splitIdx]，可能还有其他 owner 的另一组 ToolMessage
  }
  return splitIdx;
}

function findToolCallOwner(
  messages: BaseMessage[],
  toolCallId: string,
  upTo: number,
): number {
  for (let i = upTo - 1; i >= 0; i--) {
    const m = messages[i] as BaseMessage & { tool_calls?: { id?: string }[] };
    if (m._getType() !== "ai" || !Array.isArray(m.tool_calls)) continue;
    if (m.tool_calls.some((c) => c.id === toolCallId)) return i;
  }
  return -1;
}

const TOOL_RESULT_MAX_CHARS = 500;

/**
 * 把 messages 拍扁成单段文本，喂给摘要 LLM。
 *
 * 规则：
 * - HumanMessage / AIMessage 按 [user] / [assistant] 前缀加 content
 * - AIMessage 带 tool_calls 时追加一行 `  -> tool <name>(args)`
 * - ToolMessage 渲染为 `[tool <call_id>] result: <content>`；content 超过
 *   TOOL_RESULT_MAX_CHARS 时尾部截断为 "... [truncated N chars]"，防止
 *   截图 base64 等大对象递归喂回摘要 LLM 自己的 input
 */
export function serializeForSummary(messages: BaseMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const t = m._getType();
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (t === "human") {
      lines.push(`[user] ${content}`);
    } else if (t === "ai") {
      const ai = m as BaseMessage & { tool_calls?: { name?: string; args?: unknown }[] };
      if (content) lines.push(`[assistant] ${content}`);
      if (Array.isArray(ai.tool_calls) && ai.tool_calls.length > 0) {
        for (const call of ai.tool_calls) {
          lines.push(`  -> tool ${call.name ?? "?"}(${JSON.stringify(call.args ?? {})})`);
        }
      }
    } else if (t === "tool") {
      const tm = m as BaseMessage & { tool_call_id?: string };
      const truncated =
        content.length > TOOL_RESULT_MAX_CHARS
          ? `${content.slice(0, TOOL_RESULT_MAX_CHARS)}... [truncated ${
              content.length - TOOL_RESULT_MAX_CHARS
            } chars]`
          : content;
      lines.push(`[tool ${tm.tool_call_id ?? "?"}] result: ${truncated}`);
    } else if (t === "system") {
      lines.push(`[system] ${content}`);
    }
  }
  return lines.join("\n");
}

/**
 * 识别 LLM 返回的 `context_length_exceeded` 类错误。
 *
 * 不同 provider 的错误形态不同；匹配不到一律返 false，让上层走非 ctx 错误路径。
 */
export function isContextLengthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // OpenAI / DeepSeek / OpenAI-compatible
  const errCode = (e.error as { code?: string } | undefined)?.code;
  if (errCode === "context_length_exceeded") return true;
  // HTTP 400 + message 含 context 字样
  if (e.status === 400 && typeof e.message === "string" && /context/i.test(e.message)) {
    return true;
  }
  // Anthropic
  const errType = (e.error as { type?: string } | undefined)?.type;
  if (
    errType === "invalid_request_error" &&
    typeof e.message === "string" &&
    /prompt is too long/i.test(e.message)
  ) {
    return true;
  }
  // Gemini
  if (typeof e.message === "string" && /exceeds the maximum/i.test(e.message)) {
    return true;
  }
  return false;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test -- --testPathPatterns=context-compactor.utils 2>&1 | tail -10
```

Expected: PASS（约 16 条用例）

- [ ] **Step 5: 格式化 + commit**

```bash
pnpm biome check --write apps/server-agent/src/services/context-compactor.utils.ts apps/server-agent/src/services/context-compactor.utils.spec.ts 2>&1 | tail -3
git add apps/server-agent/src/services/context-compactor.utils.ts apps/server-agent/src/services/context-compactor.utils.spec.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): 上下文压缩纯函数工具

- estimateTokens：JSON 长度 / 4 启发式估 token（含 tool_calls 序列化）
- findSplitIndex：尾部往前累加 token，找保留区切分点
- expandToToolBoundary：避免切断 tool_call / tool_result 对（LLM 会 400）
- serializeForSummary：messages 拍扁文本；tool result 500 字截断防 base64 递归
- isContextLengthError：识别各 provider 的 ctx_exceeded 错误形态

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: ContextCompactor service

**Files:**
- Create: `apps/server-agent/src/services/context-compactor.service.ts`
- Create: `apps/server-agent/src/services/context-compactor.service.spec.ts`
- Modify: `apps/server-agent/src/app.module.ts`（providers 注册）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server-agent/src/services/context-compactor.service.spec.ts
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { GraphService } from "@meshbot/agent";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import { LlmCallService } from "./llm-call.service";
import { ModelConfigService } from "./model-config.service";
import { SessionMessageService } from "./session-message.service";
import {
  CompactionError,
  CompactionNothingToCompact,
  ContextCompactor,
} from "./context-compactor.service";

function buildMessages(count: number): import("@langchain/core/messages").BaseMessage[] {
  const out: import("@langchain/core/messages").BaseMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new HumanMessage({ id: `h${i}`, content: "X".repeat(400) })); // ~100 token each
    out.push(new AIMessage({ id: `a${i}`, content: "Y".repeat(400) }));
  }
  return out;
}

describe("ContextCompactor", () => {
  let compactor: ContextCompactor;
  let graph: jest.Mocked<GraphService>;
  let modelConfig: jest.Mocked<ModelConfigService>;
  let sessionMessages: jest.Mocked<SessionMessageService>;
  let emitter: EventEmitter2;
  let emitSpy: jest.SpyInstance;

  beforeEach(async () => {
    graph = {
      getMessagesSnapshot: jest.fn(),
      summarize: jest.fn(),
      applyCompaction: jest.fn(),
    } as unknown as jest.Mocked<GraphService>;
    modelConfig = {
      findEnabled: jest.fn(),
    } as unknown as jest.Mocked<ModelConfigService>;
    sessionMessages = {
      recordCompactionPlaceholder: jest.fn(),
    } as unknown as jest.Mocked<SessionMessageService>;
    emitter = new EventEmitter2();
    emitSpy = jest.spyOn(emitter, "emit");
    const moduleRef = await Test.createTestingModule({
      providers: [
        ContextCompactor,
        { provide: GraphService, useValue: graph },
        { provide: ModelConfigService, useValue: modelConfig },
        { provide: SessionMessageService, useValue: sessionMessages },
        { provide: EventEmitter2, useValue: emitter },
        // LlmCallService 在 v1 仅供未来扩展用，这里注入 mock 防 DI 报错
        { provide: LlmCallService, useValue: {} },
      ],
    }).compile();
    compactor = moduleRef.get(ContextCompactor);
  });

  it("happy path：切分 + summarize + applyCompaction + persist + 事件", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000, // 保留预算 = 1000 token
    } as never);
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(10)); // 20 条
    graph.summarize.mockResolvedValue("MOCK_SUMMARY");
    await compactor.compact("s1");
    expect(graph.summarize).toHaveBeenCalledTimes(1);
    expect(graph.applyCompaction).toHaveBeenCalledTimes(1);
    const applyArg = graph.applyCompaction.mock.calls[0][1] as {
      removeIds: string[];
      summaryText: string;
    };
    expect(applyArg.removeIds.length).toBeGreaterThan(0);
    expect(applyArg.summaryText).toBe("MOCK_SUMMARY");
    expect(sessionMessages.recordCompactionPlaceholder).toHaveBeenCalledTimes(1);
    const startEmits = emitSpy.mock.calls.filter(
      ([name]) => name === SESSION_WS_EVENTS.runCompactionStart,
    );
    const doneEmits = emitSpy.mock.calls.filter(
      ([name]) => name === SESSION_WS_EVENTS.runCompactionDone,
    );
    expect(startEmits).toHaveLength(1);
    expect(doneEmits).toHaveLength(1);
  });

  it("toSummarize 为空（非 force）→ return null 不调 LLM", async () => {
    modelConfig.findEnabled.mockResolvedValue({ contextWindow: 1_000_000 } as never);
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(2)); // 远小于预算
    const r = await compactor.compact("s1");
    expect(r).toBeNull();
    expect(graph.summarize).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("force=true 且无可压缩 → 抛 CompactionNothingToCompact", async () => {
    modelConfig.findEnabled.mockResolvedValue({ contextWindow: 1_000_000 } as never);
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(2));
    await expect(
      compactor.compact("s1", { force: true, reason: "ctx-exceeded" }),
    ).rejects.toBeInstanceOf(CompactionNothingToCompact);
  });

  it("summarize LLM 抛错 → 不动 state + emit Error + 抛 CompactionError", async () => {
    modelConfig.findEnabled.mockResolvedValue({ contextWindow: 10_000 } as never);
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    graph.summarize.mockRejectedValue(new Error("LLM down"));
    await expect(compactor.compact("s1")).rejects.toBeInstanceOf(CompactionError);
    expect(graph.applyCompaction).not.toHaveBeenCalled();
    const errEmits = emitSpy.mock.calls.filter(
      ([name]) => name === SESSION_WS_EVENTS.runCompactionError,
    );
    expect(errEmits).toHaveLength(1);
  });

  it("并发同 sessionId：第二个 await 拿到第一个 Promise，不重复跑", async () => {
    modelConfig.findEnabled.mockResolvedValue({ contextWindow: 10_000 } as never);
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    let resolveSum!: (v: string) => void;
    graph.summarize.mockReturnValue(
      new Promise<string>((r) => {
        resolveSum = r;
      }),
    );
    const p1 = compactor.compact("s1");
    const p2 = compactor.compact("s1");
    resolveSum("S");
    await Promise.all([p1, p2]);
    expect(graph.summarize).toHaveBeenCalledTimes(1);
    expect(graph.applyCompaction).toHaveBeenCalledTimes(1);
  });

  it("findEnabled 返 null（无启用 model）→ 抛 CompactionError", async () => {
    modelConfig.findEnabled.mockResolvedValue(null as never);
    await expect(compactor.compact("s1")).rejects.toBeInstanceOf(CompactionError);
  });

  it("getMessagesSnapshot 抛错 → 透传抛错（不 emit start）", async () => {
    modelConfig.findEnabled.mockResolvedValue({ contextWindow: 10_000 } as never);
    graph.getMessagesSnapshot.mockRejectedValue(new Error("checkpointer fail"));
    await expect(compactor.compact("s1")).rejects.toThrow();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
```

> **Note**：`ModelConfigService.findEnabled` 当前方法名为 `findAllEnabled` 返数组——见 [model-config.service.ts](apps/server-agent/src/services/model-config.service.ts)；compactor 应取 `findAllEnabled()[0]` 或在 Service 上新增 `findEnabled(): Promise<ModelConfig | null>` 包装。**推荐**：新增 `findEnabled` 单数方法（findAllEnabled().then(rows => rows[0] ?? null)）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- --testPathPatterns=context-compactor.service.spec 2>&1 | tail -10
```

Expected: FAIL（模块未实现）

- [ ] **Step 3: 在 ModelConfigService 加 findEnabled 单数包装**

```ts
// apps/server-agent/src/services/model-config.service.ts
import type { ModelConfig } from "../entities/model-config.entity";
// ... 类内补：
async findEnabled(): Promise<ModelConfig | null> {
  const rows = await this.findAllEnabled();
  return rows[0] ?? null;
}
```

- [ ] **Step 4: 实现 ContextCompactor**

```ts
// apps/server-agent/src/services/context-compactor.service.ts
import { GraphService, COMPACTION_SYSTEM_PROMPT } from "@meshbot/agent";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { randomUUID } from "node:crypto";
import {
  expandToToolBoundary,
  findSplitIndex,
  serializeForSummary,
} from "./context-compactor.utils";
import { LlmCallService } from "./llm-call.service";
import { ModelConfigService } from "./model-config.service";
import { SessionMessageService } from "./session-message.service";

// === 配置常量（v1 hardcoded；v2 挪到 ModelConfig 列或单独配置） ===
const COMPACTION_TRIGGER_RATIO = 0.9;
const COMPACTION_RECENT_RATIO = 0.1;
const COMPACTION_SUMMARY_MAX_TOKENS = 600;
const COMPACTION_SUMMARIZE_TIMEOUT_MS = 60_000;

/** 触发场景标签，影响 WS 事件的 reason 字段。 */
export type CompactionReason = "threshold" | "ctx-exceeded";

export interface CompactOptions {
  /** force=true 时，即便没东西可压也抛 CompactionNothingToCompact（兜底场景）。 */
  force?: boolean;
  /** 触发原因，默认 "threshold"。 */
  reason?: CompactionReason;
}

export interface CompactionResult {
  removedCount: number;
  summary: string;
}

/** 压缩流程统一错误类（getState / summarize / updateState 失败均包装成此）。 */
export class CompactionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "CompactionError";
  }
}

/** force 模式下没东西可压时抛此错。Runner 据此判定"压缩兜底彻底没救"。 */
export class CompactionNothingToCompact extends Error {
  constructor() {
    super("Nothing to compact (force=true)");
    this.name = "CompactionNothingToCompact";
  }
}

/**
 * 会话上下文压缩器（per-sessionId 锁 + 同步等待）。
 *
 * - `compact(sessionId)` 是入口：进锁 → 取 messages → 算切分 → summarize →
 *   applyCompaction → recordCompactionPlaceholder → emit done。
 * - 失败时 emit error 抛 CompactionError；调用方（runner）决定是否兜底。
 * - 并发同 sessionId 第二次调用直接 await 第一次的 Promise。
 *
 * 设计稿：docs/superpowers/specs/2026-05-26-context-compaction-design.md
 */
@Injectable()
export class ContextCompactor {
  private readonly logger = new Logger(ContextCompactor.name);
  private readonly locks = new Map<string, Promise<CompactionResult | null>>();

  constructor(
    private readonly graph: GraphService,
    private readonly modelConfig: ModelConfigService,
    private readonly sessionMessages: SessionMessageService,
    private readonly llmCalls: LlmCallService, // v1 未直接用，预留 v2 标记 purpose 用
    private readonly emitter: EventEmitter2,
  ) {}

  /** 给 runner pre-check 用：返 true 表示当前 lastInputTokens 已触阈值。 */
  shouldCompact(lastInputTokens: number, contextWindow: number): boolean {
    if (!contextWindow || contextWindow <= 0) return false;
    return lastInputTokens / contextWindow >= COMPACTION_TRIGGER_RATIO;
  }

  /** 入口：同步等待压缩完成。同 sessionId 并发会被锁串行化。 */
  async compact(
    sessionId: string,
    opts: CompactOptions = {},
  ): Promise<CompactionResult | null> {
    const existing = this.locks.get(sessionId);
    if (existing) return existing;
    const p = this.doCompact(sessionId, opts).finally(() =>
      this.locks.delete(sessionId),
    );
    this.locks.set(sessionId, p);
    return p;
  }

  private async doCompact(
    sessionId: string,
    opts: CompactOptions,
  ): Promise<CompactionResult | null> {
    const reason: CompactionReason = opts.reason ?? "threshold";
    const model = await this.modelConfig.findEnabled();
    if (!model) {
      throw new CompactionError("No enabled ModelConfig");
    }
    const ctx = model.contextWindow;
    const messages = await this.graph.getMessagesSnapshot(sessionId);

    // 切分
    const keepBudget = Math.floor(ctx * COMPACTION_RECENT_RATIO);
    let splitIdx = findSplitIndex(messages, keepBudget);
    splitIdx = expandToToolBoundary(messages, splitIdx);
    if (splitIdx === 0) {
      if (opts.force) throw new CompactionNothingToCompact();
      return null;
    }
    if (messages.length - splitIdx < 2) {
      splitIdx = Math.max(0, messages.length - 2);
    }
    const toSummarize = messages.slice(0, splitIdx);

    // 发 start 事件
    this.emitter.emit(SESSION_WS_EVENTS.runCompactionStart, {
      sessionId,
      reason,
    });

    let summaryText: string;
    try {
      const serialized = serializeForSummary(toSummarize);
      summaryText = await this.graph.summarize(serialized, {
        systemPrompt: COMPACTION_SYSTEM_PROMPT,
        timeoutMs: COMPACTION_SUMMARIZE_TIMEOUT_MS,
        maxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
      });
    } catch (err) {
      this.emitter.emit(SESSION_WS_EVENTS.runCompactionError, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new CompactionError("Summarize LLM call failed", err);
    }

    // 改写 checkpointer
    try {
      await this.graph.applyCompaction(sessionId, {
        removeIds: toSummarize
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string"),
        summaryText,
      });
    } catch (err) {
      this.emitter.emit(SESSION_WS_EVENTS.runCompactionError, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new CompactionError("applyCompaction failed", err);
    }

    // 占位行（失败仅 log，不回滚）
    try {
      await this.sessionMessages.recordCompactionPlaceholder({
        id: `comp-${randomUUID()}`,
        sessionId,
        summary: summaryText,
        removedCount: toSummarize.length,
        fromMessageId: toSummarize[0].id ?? "",
        toMessageId: toSummarize[toSummarize.length - 1].id ?? "",
      });
    } catch (err) {
      this.logger.warn(
        `recordCompactionPlaceholder failed; checkpointer 已正确，仅 UI 占位行丢失 session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // done
    this.emitter.emit(SESSION_WS_EVENTS.runCompactionDone, {
      sessionId,
      removedCount: toSummarize.length,
      summaryPreview: summaryText.slice(0, 200),
    });

    this.logger.log(
      `compaction done session=${sessionId} removed=${toSummarize.length} reason=${reason}`,
    );
    return { removedCount: toSummarize.length, summary: summaryText };
  }
}
```

- [ ] **Step 5: 注册到 app.module.ts**

打开 `apps/server-agent/src/app.module.ts`，在 `providers` 数组里加 `ContextCompactor`（import + 放置位置贴现有服务 group）。

- [ ] **Step 6: 跑测试确认通过**

```bash
pnpm test -- --testPathPatterns=context-compactor.service.spec 2>&1 | tail -15
```

Expected: PASS（7 个用例）

- [ ] **Step 7: 跑 server-agent 全量测试防回归**

```bash
pnpm test 2>&1 | tail -8
```

Expected: 之前的测试套数 + 本次新加用例都过

- [ ] **Step 8: 格式化 + commit**

```bash
pnpm biome check --write \
  apps/server-agent/src/services/context-compactor.service.ts \
  apps/server-agent/src/services/context-compactor.service.spec.ts \
  apps/server-agent/src/services/model-config.service.ts \
  apps/server-agent/src/app.module.ts 2>&1 | tail -3
git add apps/server-agent/src/services/context-compactor.service.ts \
        apps/server-agent/src/services/context-compactor.service.spec.ts \
        apps/server-agent/src/services/model-config.service.ts \
        apps/server-agent/src/app.module.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): 加 ContextCompactor 服务（per-session 锁 + summarize 编排）

- compact(sessionId, opts): 同步等待入口；并发锁防重入
- doCompact: 算切分 → emit start → graph.summarize → graph.applyCompaction
  → recordCompactionPlaceholder → emit done
- 失败路径：emit error + 抛 CompactionError；recordCompactionPlaceholder
  失败不回滚（仅 log warn）
- shouldCompact(): pre-check 判定，封装 lastInputTokens / ctx ≥ 0.9
- 错误类：CompactionError / CompactionNothingToCompact

附带：ModelConfigService 加 findEnabled() 单数包装，便于 compactor 取
单一启用配置。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Runner pre-check + ctx-exceeded 兜底

**Files:**
- Modify: `apps/server-agent/src/services/runner.service.ts`
- Modify / Create: `apps/server-agent/src/services/runner.service.spec.ts`

- [ ] **Step 1: 写失败测试**

在现有 spec 文件（或新建）中追加：

```ts
// apps/server-agent/src/services/runner.service.spec.ts (片段)
import { ContextCompactor } from "./context-compactor.service";

describe("RunnerService context compaction integration", () => {
  // 复用 spec 文件既有 setup；只新增 mock ContextCompactor 注入

  let compactor: jest.Mocked<ContextCompactor>;
  let llmCalls: jest.Mocked<LlmCallService>;
  let modelConfig: jest.Mocked<ModelConfigService>;

  beforeEach(() => {
    compactor = {
      compact: jest.fn(),
      shouldCompact: jest.fn(),
    } as unknown as jest.Mocked<ContextCompactor>;
    // 在 TestingModule 里把 ContextCompactor / LlmCallService.getLastBySession /
    // ModelConfigService.findEnabled 替换为 mock
  });

  it("pre-check: lastInputTokens/ctx ≥ 0.9 时调 compactor.compact 后才进 streamMessage", async () => {
    llmCalls.getLastBySession.mockResolvedValue({ inputTokens: 950_000 } as never);
    modelConfig.findEnabled.mockResolvedValue({ contextWindow: 1_000_000 } as never);
    compactor.shouldCompact.mockReturnValue(true);
    compactor.compact.mockResolvedValue({ removedCount: 5, summary: "S" });
    // ... 触发 runOnce，验证调用顺序：compact 先于 streamMessage
  });

  it("pre-check: 比例 < 0.9 → 不调 compact", async () => {
    llmCalls.getLastBySession.mockResolvedValue({ inputTokens: 100 } as never);
    modelConfig.findEnabled.mockResolvedValue({ contextWindow: 1_000_000 } as never);
    compactor.shouldCompact.mockReturnValue(false);
    // ... 触发 runOnce，验证 compact 未被调
  });

  it("pre-check 命中但 compact 抛错 → 不进 streamMessage + 标 message failed", async () => {
    compactor.shouldCompact.mockReturnValue(true);
    compactor.compact.mockRejectedValue(new Error("compact fail"));
    // ... 验证 streamMessage 未被调，markFailed 被调
  });

  it("streamMessage 抛 ctx_exceeded → 强制 compact + 重试一次成功", async () => {
    compactor.shouldCompact.mockReturnValue(false); // pre-check 未命中
    // streamMessage 第一次抛 ctx_exceeded（构造合规错误体）；第二次成功
    // 验证 compactor.compact 被调一次（force: true, reason: "ctx-exceeded"）
    // streamMessage 被调两次
  });

  it("streamMessage 抛非 ctx 错 → 不触发兜底，原样抛", async () => {
    // streamMessage 抛普通 Error("network")
    // 验证 compactor.compact 未被调，原错误透传
  });

  it("兜底压缩成功但重试仍 ctx_exceeded → 抛原错不再继续", async () => {
    // streamMessage 两次都抛 ctx_exceeded
    // 验证 compactor.compact 仅调一次（force: true），不重复兜底
  });
});
```

> **Note**：现有 runner.service.spec.ts 如未引入 ContextCompactor，构造 TestingModule 时把 `ContextCompactor`、`LlmCallService` 新方法、`ModelConfigService.findEnabled` 都 mock 进去。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- --testPathPatterns=runner.service.spec 2>&1 | tail -10
```

Expected: FAIL（runner 还没接入 compactor）

- [ ] **Step 3: 实现 pre-check 与 ctx-exceeded catch**

在 `apps/server-agent/src/services/runner.service.ts`：

1. 构造函数加 `ContextCompactor` / `ModelConfigService` 注入：

```ts
import { ContextCompactor } from "./context-compactor.service";
import { ModelConfigService } from "./model-config.service";
import { isContextLengthError } from "./context-compactor.utils";

constructor(
  private readonly sessions: SessionService,
  private readonly graph: GraphService,
  private readonly emitter: EventEmitter2,
  private readonly llmCalls: LlmCallService,
  private readonly sessionMessages: SessionMessageService,
  private readonly compactor: ContextCompactor,
  private readonly modelConfig: ModelConfigService,
) {}
```

2. 在 `runOnce` 顶部、`this.inflight.set(sessionId, run)` **之前** 加 pre-check：

```ts
private async runOnce(
  sessionId: string,
  batch: { id: string; content: string }[],
  resume: boolean,
): Promise<void> {
  // === Pre-check：lastInputTokens / contextWindow ≥ 0.9 时同步压缩 ===
  try {
    const lastCall = await this.llmCalls.getLastBySession(sessionId);
    const model = await this.modelConfig.findEnabled();
    if (
      lastCall &&
      model &&
      this.compactor.shouldCompact(lastCall.inputTokens, model.contextWindow)
    ) {
      this.logger.log(
        `pre-check 命中阈值 session=${sessionId} input=${lastCall.inputTokens} ctx=${model.contextWindow} → 同步压缩`,
      );
      await this.compactor.compact(sessionId, { reason: "threshold" });
    }
  } catch (preErr) {
    this.logger.warn(
      `pre-check 压缩失败 session=${sessionId}：${preErr instanceof Error ? preErr.message : String(preErr)}`,
    );
    // pre-check 失败 → 标 message failed 并抛错，让消费循环中止
    await this.sessions.markFailed(batch.map((b) => b.id));
    this.emitter.emit(SESSION_WS_EVENTS.runError, {
      sessionId,
      messageId: null,
      pendingIds: batch.map((b) => b.id),
      error:
        preErr instanceof Error ? preErr.message : String(preErr),
    });
    throw preErr;
  }

  const ids = batch.map((m) => m.id);
  // ... 原 runOnce body 不变
}
```

3. 在 `try { ... stream 迭代 ... }` 抛错时，把 catch 区扩展加 ctx-exceeded 兜底（已有 catch 在 line ~365 附近）。把现有 catch 改为：

```ts
} catch (err) {
  // === ctx-exceeded 兜底：强制压缩 + 重试一次（只一次） ===
  if (isContextLengthError(err) && !resume) {
    this.logger.warn(
      `ctx_exceeded session=${sessionId}; 强制压缩并重试一次`,
    );
    try {
      await this.compactor.compact(sessionId, {
        force: true,
        reason: "ctx-exceeded",
      });
    } catch (compactErr) {
      this.logger.warn(
        `兜底压缩失败 session=${sessionId}：${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
      );
      // 压缩兜底失败 → 抛原 ctx 错给用户
      await this.handleRunFailure(sessionId, run, ids, err);
      throw err;
    }
    // 重试：递归调一次 streamMessage，注意把 resume 保持原值（false）
    // 但要避免无限递归 —— 加一个简单的"已重试"标记，本次方法体外不重试
    try {
      const retryStream = this.graph.streamMessage(
        sessionId,
        batch,
        run.abort.signal,
      );
      for await (const event of retryStream) {
        // 复用原 stream 处理逻辑：抽到一个内部 method handleStreamEvent
        // 以便此处复用
        await this.handleStreamEvent(event, sessionId, run, batch, runStartedAt);
      }
      run.status = "done";
      await this.sessions.markProcessed(ids);
      if (run.messageId) {
        this.emitter.emit(SESSION_WS_EVENTS.runDone, {
          sessionId,
          messageId: run.messageId,
          content: run.content,
        });
      }
      return;
    } catch (retryErr) {
      await this.handleRunFailure(sessionId, run, ids, retryErr);
      throw retryErr;
    }
  }
  // 原有的非 ctx 错误路径
  await this.handleRunFailure(sessionId, run, ids, err);
  throw err;
}
```

> **重构提示**：把 stream for-await 循环里的事件处理抽成 `handleStreamEvent` 私有方法，让重试逻辑能复用。也把现有 catch 末尾的"标 failed + emit runError"抽成 `handleRunFailure`。两个抽取都是机械重构，不改语义。

4. 注意 `AppModule` 已通过 Task 7 添加了 `ContextCompactor` provider，但 runner 注入的 `ModelConfigService` 在现有 provider 列表内（通过 sessions / setup 那条链）。如果不在，需要在 `app.module.ts` 把 ModelConfigService 加入 RunnerService 所在 module 的 imports / providers。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test -- --testPathPatterns=runner.service.spec 2>&1 | tail -15
```

Expected: PASS（6 个新用例 + 既有用例）

- [ ] **Step 5: typecheck + 全量回归**

```bash
pnpm -r typecheck 2>&1 | tail -8
pnpm test 2>&1 | tail -8
```

Expected: 全 Done / 全 PASS（排除 libs/agent 历史 3 个预存失败）

- [ ] **Step 6: 格式化 + commit**

```bash
pnpm biome check --write apps/server-agent/src/services/runner.service.ts apps/server-agent/src/services/runner.service.spec.ts 2>&1 | tail -3
git add apps/server-agent/src/services/runner.service.ts apps/server-agent/src/services/runner.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): runner 接入 ContextCompactor pre-check + 兜底重试

- runOnce 顶部 pre-check：lastInputTokens / ctx ≥ 0.9 时同步等待
  compactor.compact() 完成才进 streamMessage
- streamMessage 抛 isContextLengthError(err) 时：
  - 强制 compactor.compact({ force: true, reason: "ctx-exceeded" })
  - 重试 streamMessage 一次（仅一次）
  - 重试仍失败抛原 ctx 错给用户
- Pre-check 自身失败：标 batch failed + emit runError + 抛错中止消费循环
- 非 ctx 错误维持原 catch 路径不变

抽取 handleStreamEvent / handleRunFailure 私有方法供重试复用。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 前端 session-usage atom 加 lastInputTokens

**Files:**
- Modify: `apps/web-agent/src/atoms/session-usage.ts`

> `SessionTotals` 类型来自 `@meshbot/types-agent`，Task 1 已经加了 `lastInputTokens` 字段。前端 atom 文件 [apps/web-agent/src/atoms/session-usage.ts](apps/web-agent/src/atoms/session-usage.ts) 里有两份手工维护的 SessionTotals 数据（EMPTY_TOTALS 常量 + computeTotals 函数 + appendUsageAtom 的 incremental update），都需要同步加新字段。

- [ ] **Step 1: 改 EMPTY_TOTALS**

```ts
const EMPTY_TOTALS: SessionTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  callCount: 0,
  lastInputTokens: 0,
};
```

- [ ] **Step 2: 改 computeTotals**

`computeTotals(byMessage)` 用一个 Record 算总和，但 Record 没有顺序信息，没法可靠地知道"最后一条"。改为：

```ts
function computeTotals(
  byMessage: Record<string, MessageUsage>,
  lastInputTokens: number,
): SessionTotals {
  let inputTokens = 0;
  // ... 既有累加
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    callCount,
    lastInputTokens,
  };
}
```

- [ ] **Step 3: 改 setInitialUsageAtom**

`setInitialUsageAtom` 现在依赖 `u: SessionUsage` 的 `sessionTotals.lastInputTokens`（Task 1 已加，server 直接送），不再 compute：

```ts
export const setInitialUsageAtom = atom(null, (get, set, u: SessionUsage) => {
  const existing = get(usageByMessageAtom);
  const merged: Record<string, MessageUsage> = { ...u.byMessage };
  for (const [id, m] of Object.entries(existing)) {
    merged[id] = m;
  }
  set(usageByMessageAtom, merged);
  // sessionTotals 求和不变；lastInputTokens 信任服务端字段（首次 load 时 server 是源）
  set(
    sessionTotalsAtom,
    computeTotals(merged, u.sessionTotals.lastInputTokens),
  );
});
```

- [ ] **Step 4: 改 appendUsageAtom**

实时事件来时更新 lastInputTokens（每条新 usage 都是"刚刚发生的请求"）：

```ts
export const appendUsageAtom = atom(null, (get, set, u: RunUsageEvent) => {
  const existing = get(usageByMessageAtom);
  if (existing[u.messageId]) return;
  // ... 既有 single 构造
  set(usageByMessageAtom, byMessage);
  const t = get(sessionTotalsAtom);
  set(sessionTotalsAtom, {
    inputTokens: t.inputTokens + u.inputTokens,
    outputTokens: t.outputTokens + u.outputTokens,
    totalTokens: t.totalTokens + u.totalTokens,
    cacheReadTokens: t.cacheReadTokens + u.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens + u.cacheCreationTokens,
    reasoningTokens: t.reasoningTokens + u.reasoningTokens,
    callCount: t.callCount + 1,
    lastInputTokens: u.inputTokens, // 新增：每次 usage 覆盖
  });
});
```

- [ ] **Step 5: typecheck**

```bash
cd /Users/grant/Meta1/meshbot
pnpm -r typecheck 2>&1 | tail -5
```

Expected: Done。如果 `SessionUsage.sessionTotals.lastInputTokens` 类型推不出，回头检查 Task 1 的 SessionTotalsSchema 是否正确导出。

- [ ] **Step 6: 格式化 + commit**

```bash
pnpm biome check --write apps/web-agent/src/atoms/session-usage.ts 2>&1 | tail -3
git add apps/web-agent/src/atoms/session-usage.ts
git commit -m "$(cat <<'EOF'
feat(web-agent): session-usage atom 加 lastInputTokens

- EMPTY_TOTALS 默认 0
- computeTotals 接收 lastInputTokens 参数（byMessage Record 无序，没法
  从中算出"最新"）
- setInitialUsageAtom 信任 server 端 sessionTotals.lastInputTokens
- appendUsageAtom 每次新 usage 事件覆盖为最新值

为进度环数据源切换"上次 input / ctx 上限"做铺垫。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: 进度环数据源切换 + breakdown 调整

**Files:**
- Modify: `apps/web-agent/src/app/session/page.tsx`（`tokenUsage` 构造处）
- Modify: `apps/web-agent/src/components/common/chat-input.tsx`（breakdown 显示）
- Modify: i18n 文案

- [ ] **Step 1: 调整 session/page.tsx 把 current 改为 lastInputTokens**

```tsx
// apps/web-agent/src/app/session/page.tsx 在 ChatInput 那个 tokenUsage 块
tokenUsage={{
  current: sessionTotals.lastInputTokens,
  max: contextWindow,
  breakdown: {
    inputTokens: sessionTotals.inputTokens,
    outputTokens: sessionTotals.outputTokens,
    cacheReadTokens: sessionTotals.cacheReadTokens,
    reasoningTokens: sessionTotals.reasoningTokens,
    callCount: sessionTotals.callCount,
    /** 新增：当前会话累计 token，作为辅助信息显示。 */
    cumulativeTokens: sessionTotals.totalTokens,
  },
}}
```

- [ ] **Step 2: chat-input.tsx 调整 tooltip 文案**

在 breakdown 显示区域：
- 主行：「下次预估 X / Y」
- tooltip 副信息：「累计 X token，共调用 N 次」+ 既有 input/output/cache/reasoning 拆分

具体修改参照现有 tokenUsage.breakdown 渲染逻辑，把 `formatTokens(tokenUsage.current)` 含义 reframe 为「下次请求」而非「累计」，并用 i18n key 新增 `nextRequestLabel` / `cumulativeLabel` 文案。

- [ ] **Step 3: i18n 文案**

`apps/web-agent/messages/zh.json` + `en.json` 的 `session.usage` 添加：

```json
{
  "session": {
    "usage": {
      "nextRequestLabel": "下次预估",       // en: "Next request"
      "cumulativeLabel": "累计",            // en: "Cumulative"
      "ofMaxFmt": "{current} / {max}"      // 复用即可
    }
  }
}
```

- [ ] **Step 4: 起 dev 服务跑一遍肉眼验证**

```bash
pnpm dev:server-agent &
pnpm dev:web-agent &
# 浏览器打开 localhost:3001，找一个有调用记录的会话，看进度环显示是否切换为
# 「下次预估 X / Y」格式
```

> 这一步不强制写自动化测试。chat-input 的展示逻辑测试在现有项目较稀薄，把主要测试投入放在后端 service 上。

- [ ] **Step 5: 格式化 + commit**

```bash
pnpm biome check --write apps/web-agent/src/app/session/page.tsx apps/web-agent/src/components/common/chat-input.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json 2>&1 | tail -3
git add apps/web-agent/src/app/session/page.tsx apps/web-agent/src/components/common/chat-input.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "$(cat <<'EOF'
feat(web-agent): 进度环数据源换 lastInputTokens；累加值降级为辅助信息

主显示从"累加 sum / ctx 上限"改为"下次请求估算 lastInputTokens /
ctx 上限"——量纲一致；累计 token 与调用次数降到 tooltip 辅助行。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: session/page banner 接 compaction WS 事件

**Files:**
- Create: `apps/web-agent/src/components/common/compaction-banner.tsx`
- Modify: `apps/web-agent/src/app/session/page.tsx`
- Modify: i18n

- [ ] **Step 1: 写 CompactionBanner 组件**

```tsx
// apps/web-agent/src/components/common/compaction-banner.tsx
"use client";

import { useTranslations } from "next-intl";

interface CompactionBannerProps {
  visible: boolean;
  reason?: "threshold" | "ctx-exceeded";
}

/**
 * Session 顶部的"会话历史压缩中"提示条。
 *
 * visible=true 时显示；reason 决定文案细微差别。
 */
export function CompactionBanner({ visible, reason }: CompactionBannerProps) {
  const t = useTranslations("session.compaction");
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
    >
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary/70" />
      <span>
        {reason === "ctx-exceeded" ? t("bannerCtxExceeded") : t("bannerThreshold")}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: i18n 文案**

`zh.json` 的 `session` 下加：

```json
"compaction": {
  "bannerThreshold": "会话历史压缩中…",
  "bannerCtxExceeded": "上下文已满，正在压缩历史以继续…",
  "rowTitle": "已压缩 {count} 条早期消息",
  "rowExpand": "查看摘要",
  "rowCollapse": "收起"
}
```

`en.json` 对应：

```json
"compaction": {
  "bannerThreshold": "Compacting conversation history…",
  "bannerCtxExceeded": "Context full; compacting to continue…",
  "rowTitle": "Compacted {count} earlier messages",
  "rowExpand": "Show summary",
  "rowCollapse": "Hide"
}
```

- [ ] **Step 3: session/page.tsx 订阅事件**

打开 `apps/web-agent/src/app/session/page.tsx`，在已有的 WS 事件 handler 旁加：

```ts
const [compacting, setCompacting] = useState<null | "threshold" | "ctx-exceeded">(null);

useEffect(() => {
  const socket = getSessionSocket();
  const onStart = (payload: { sessionId: string; reason: "threshold" | "ctx-exceeded" }) => {
    if (payload.sessionId !== currentSessionId) return;
    setCompacting(payload.reason);
  };
  const onDone = (payload: { sessionId: string }) => {
    if (payload.sessionId !== currentSessionId) return;
    setCompacting(null);
    // 同时强制刷新 history listPage 以拿到新的 compaction 占位行
    queryClient.invalidateQueries({ queryKey: ["session-history", currentSessionId] });
  };
  const onError = (payload: { sessionId: string; error: string }) => {
    if (payload.sessionId !== currentSessionId) return;
    setCompacting(null);
    toast.error(t("compaction.toastError", { message: payload.error }));
  };
  socket.on(SESSION_WS_EVENTS.runCompactionStart, onStart);
  socket.on(SESSION_WS_EVENTS.runCompactionDone, onDone);
  socket.on(SESSION_WS_EVENTS.runCompactionError, onError);
  return () => {
    socket.off(SESSION_WS_EVENTS.runCompactionStart, onStart);
    socket.off(SESSION_WS_EVENTS.runCompactionDone, onDone);
    socket.off(SESSION_WS_EVENTS.runCompactionError, onError);
  };
}, [currentSessionId, queryClient, t]);
```

并在页面顶部布局插入 `<CompactionBanner visible={!!compacting} reason={compacting ?? undefined} />`，放在消息列表上方。

- [ ] **Step 4: 起 dev 服务肉眼验证**

构造一个长会话（或临时把 `COMPACTION_TRIGGER_RATIO` 在 server 端改为 0.05 触发压缩），观察 banner 出现/消失。

- [ ] **Step 5: 格式化 + commit**

```bash
pnpm biome check --write apps/web-agent/src/components/common/compaction-banner.tsx apps/web-agent/src/app/session/page.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json 2>&1 | tail -3
git add apps/web-agent/src/components/common/compaction-banner.tsx apps/web-agent/src/app/session/page.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "$(cat <<'EOF'
feat(web-agent): session 顶部 compaction banner + WS 事件订阅

- 新增 CompactionBanner 组件（visible + reason 控制显示）
- session/page 订阅 runCompactionStart/Done/Error 三个事件，维护
  本地 compacting 状态
- done 同时 invalidate history query，让新的占位行随刷新出现
- error 触发 toast

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: session_messages 列表渲染 compaction 占位行

**Files:**
- Create: `apps/web-agent/src/components/session/compaction-row.tsx`
- Modify: `apps/web-agent/src/components/session/message-list.tsx`
- Modify: 后端 history endpoint 把 metadata 字段透传给前端（如未透传）

- [ ] **Step 1: 检查后端 history endpoint 是否透传 metadata**

```bash
grep -n "metadata" /Users/grant/Meta1/meshbot/apps/server-agent/src/controllers/session.controller.ts
```

如果 history 投影没带 metadata 字段，加：

```ts
// controllers/session.controller.ts 的 history 响应映射
return {
  // ... 既有字段
  metadata: m.metadata ? JSON.parse(m.metadata) : null,
};
```

同时 `libs/types-agent/src/session.ts` 的 `HistoryMessageSchema` 加可选 `metadata`：

```ts
metadata: z
  .object({
    kind: z.literal("compaction"),
    removedCount: z.number(),
    fromMessageId: z.string(),
    toMessageId: z.string(),
  })
  .nullable()
  .optional(),
```

- [ ] **Step 2: CompactionRow 组件**

```tsx
// apps/web-agent/src/components/session/compaction-row.tsx
"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface CompactionRowProps {
  removedCount: number;
  summary: string;
}

/**
 * 时间线压缩占位行（折叠可展开看摘要）。
 *
 * 在 session_messages 中以 role=system + metadata.kind="compaction" 标识，
 * message-list 识别后用本组件渲染代替普通系统消息。
 */
export function CompactionRow({ removedCount, summary }: CompactionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useTranslations("session.compaction");
  return (
    <div className="flex flex-col gap-1 border-l-2 border-muted-foreground/30 pl-3 text-xs text-muted-foreground">
      <button
        type="button"
        className="flex items-center gap-1.5 hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span>{t("rowTitle", { count: removedCount })}</span>
      </button>
      {expanded && (
        <pre className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed">
          {summary}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 3: message-list 识别并渲染**

```tsx
// apps/web-agent/src/components/session/message-list.tsx
// 在普通系统消息 / user / assistant 分支前加一个 metadata.kind 判定：
if (m.role === "system" && (m.metadata as { kind?: string } | null)?.kind === "compaction") {
  const meta = m.metadata as { kind: "compaction"; removedCount: number };
  return (
    <CompactionRow
      key={m.id}
      removedCount={meta.removedCount}
      summary={m.content}
    />
  );
}
```

- [ ] **Step 4: 起 dev 验证**

触发一次压缩后查看时间线，应在原历史消息和新消息之间出现一个折叠条，展开能看到 LLM 生成的摘要文本。

- [ ] **Step 5: 格式化 + commit**

```bash
pnpm biome check --write apps/web-agent/src/components/session/compaction-row.tsx apps/web-agent/src/components/session/message-list.tsx apps/server-agent/src/controllers/session.controller.ts libs/types-agent/src/session.ts 2>&1 | tail -3
git add apps/web-agent/src/components/session/compaction-row.tsx apps/web-agent/src/components/session/message-list.tsx apps/server-agent/src/controllers/session.controller.ts libs/types-agent/src/session.ts
git commit -m "$(cat <<'EOF'
feat(web-session): 时间线渲染 compaction 占位行（折叠展示摘要）

- 新增 CompactionRow 折叠组件
- message-list 识别 metadata.kind=compaction 时走该组件
- history endpoint 把 SessionMessage.metadata 反序列化后透传
- HistoryMessageSchema 加可选 metadata 字段

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist

每个 Task 完成后，对照 spec：

- [ ] Spec section 1 分层与文件结构 → 任务表已覆盖每个文件
- [ ] Spec section 3 触发流程 → Task 7 实现 pre-check + ctx-exceeded catch
- [ ] Spec section 4 压缩算法（切分 / serialize / summarize / state 改写） → Task 5+6+7 各自分担
- [ ] Spec section 5 失败矩阵 → Task 6 ContextCompactor 7 个测试用例 + Task 7 兜底单测
- [ ] Spec section 6 WS 事件 → Task 1 schema + Task 6 emit + Task 11 前端订阅
- [ ] Spec section 7 进度环改造 → Task 4 lastInputTokens + Task 9 类型 + Task 10 UI
- [ ] Spec section 8 测试 → Task 5/6/7 都附带单测
- [ ] Spec section 9 配置常量 → Task 6 hardcoded
- [ ] Spec section 10 v1 范围外 → 计划未涉及（正确）

**类型一致性确认**：
- `CompactionReason` = "threshold" | "ctx-exceeded"，Task 1 zod 与 Task 6 service 一致
- `recordCompactionPlaceholder` 入参 Task 4 / Task 6 调用方一致
- `ContextCompactor.shouldCompact` / `compact` 签名 Task 6 定义 / Task 7 调用一致

**没占位**：所有任务步骤都给了完整代码或具体 diff 指引；测试用例都给了完整代码块。

---

完成所有任务后整库跑：

```bash
cd /Users/grant/Meta1/meshbot
pnpm -r typecheck 2>&1 | tail -8
pnpm test 2>&1 | tail -6
pnpm check 2>&1 | tail -10
```

期望：typecheck 全 Done、jest 通过、所有静态围栏通过。
