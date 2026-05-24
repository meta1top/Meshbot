# 用户消息复制 + 重生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每条 user 气泡下方加 hover-显的 copy / regenerate 按钮；重生成 = 删该消息之后的所有 session_messages / llm_calls / checkpointer state，然后从该 user 消息重跑 LLM。failed 状态背景变浅错误色，按钮默认显（标「重试」）。

**Architecture:** 后端新 `POST /messages/:msgId/regenerate` —— SessionService 编排删三处（session_messages.deleteAfter + llm_calls.deleteAfter + GraphService.cutMessagesAfter 用 RemoveMessage 剪 checkpointer），然后 runner.kickResume 走 resumeStream 重跑。前端新 UserMessageActions 组件挂 user 气泡下方，乐观截断 timeline + 调接口。

**Tech Stack:** NestJS、TypeORM SQLite（MoreThan 操作符）、LangGraph RemoveMessage reducer、React、navigator.clipboard、lucide-react。

---

## 文件结构

**Spec ref：** `docs/superpowers/specs/2026-05-25-user-message-copy-regenerate-design.md`

### 后端

| 路径 | 责任 |
|---|---|
| `apps/server-agent/src/services/session-message.service.ts`（改） | 加 `findByIdOrFail` / `deleteAfter` |
| `apps/server-agent/src/services/llm-call.service.ts`（改） | 加 `deleteAfter` |
| `libs/agent/src/graph/graph.service.ts`（改） | 加 `cutMessagesAfter(threadId, cutoffMessageId)` |
| `apps/server-agent/src/services/session.service.ts`（改） | 加 `regenerateAfter`；inject GraphService |
| `apps/server-agent/src/services/runner.service.ts`（改） | 加 `kickResume` + `kickResumeAndWait` |
| `apps/server-agent/src/controllers/session.controller.ts`（改） | 加 POST `/messages/:msgId/regenerate` |

### 前端

| 路径 | 责任 |
|---|---|
| `apps/web-agent/src/rest/session.ts`（改） | 加 `regenerateMessage(sessionId, messageId)` |
| `apps/web-agent/src/components/session/user-message-actions.tsx`（新） | copy + regenerate 按钮组 |
| `apps/web-agent/src/components/session/message-list.tsx`（改） | user 气泡背景按 failed 上色；裁掉「失败 [重试]」inline；挂 UserMessageActions |
| `apps/web-agent/src/app/session/page.tsx`（改） | MessageList 传 sessionId/running/onRegenerateOptimisticCut；删 onRetry 流转给 user 的部分 |

---

## Task 1：SessionMessageService.findByIdOrFail + deleteAfter

**Files:**
- Modify: `apps/server-agent/src/services/session-message.service.ts`
- Test: `apps/server-agent/src/services/session-message.service.spec.ts`

- [ ] **Step 1：写失败测试**

在 `session-message.service.spec.ts` 末尾追加：

```ts
import { NotFoundException } from "@nestjs/common";

describe("findByIdOrFail / deleteAfter", () => {
  it("findByIdOrFail 不存在抛 NotFoundException", async () => {
    await expect(service.findByIdOrFail("nope")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("findByIdOrFail 存在返回 entity", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
    const r = await service.findByIdOrFail("u1");
    expect(r.id).toBe("u1");
    expect(r.content).toBe("a");
  });

  it("deleteAfter 删 createdAt > cutoff 的消息，cutoff 本身保留", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "A" });
    await new Promise((r) => setTimeout(r, 10));
    await service.recordAssistant({
      id: "a1",
      sessionId: "s1",
      content: "B",
      reasoning: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    await service.recordUser({ id: "u2", sessionId: "s1", content: "C" });
    const cutoffMsg = await service.findByIdOrFail("u1");
    await service.deleteAfter("s1", cutoffMsg.createdAt);
    const page = await service.listPage("s1", { limit: 10 });
    expect(page.messages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("deleteAfter 不影响其他 session", async () => {
    await service.recordUser({ id: "x1", sessionId: "s1", content: "x" });
    await new Promise((r) => setTimeout(r, 10));
    await service.recordUser({ id: "y1", sessionId: "s2", content: "y" });
    const cutoff = await service.findByIdOrFail("x1");
    await service.deleteAfter("s1", cutoff.createdAt);
    const p = await service.listPage("s2", { limit: 10 });
    expect(p.messages.map((m) => m.id)).toEqual(["y1"]);
  });
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm jest apps/server-agent/src/services/session-message.service.spec.ts 2>&1 | tail -15
```

Expected：4 个 case fail（方法不存在）。

- [ ] **Step 3：实现**

编辑 `apps/server-agent/src/services/session-message.service.ts`：

a) 顶部 import 加 `MoreThan` 和 `NotFoundException`：

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, MoreThan, Repository } from "typeorm";
```

b) 在 `deleteBySession` 后追加（在类闭合 `}` 之前）：

```ts
/** 取一条消息，按 id 查；不存在抛 NotFoundException。 */
async findByIdOrFail(messageId: string): Promise<SessionMessage> {
  const row = await this.repo.findOneBy({ id: messageId });
  if (!row) {
    throw new NotFoundException(`SessionMessage ${messageId} not found`);
  }
  return row;
}

/**
 * 删某会话内 createdAt > cutoff 的所有消息。供「重生成」剪 history 用。
 * cutoff 本身保留（严格 >，不是 >=）。
 */
async deleteAfter(sessionId: string, cutoff: Date): Promise<void> {
  await this.repo.delete({
    sessionId,
    createdAt: MoreThan(cutoff),
  });
}
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm jest apps/server-agent/src/services/session-message.service.spec.ts 2>&1 | tail -10
```

Expected：全部 PASS。

- [ ] **Step 5：commit**

```bash
git add apps/server-agent/src/services/session-message.service.ts \
        apps/server-agent/src/services/session-message.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(session-message): findByIdOrFail + deleteAfter

供「重生成」端点剪 history 用：findByIdOrFail 拿 cutoff 的 createdAt，
deleteAfter 严格 > 该时间删后续行（cutoff 本身保留）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：LlmCallService.deleteAfter

**Files:**
- Modify: `apps/server-agent/src/services/llm-call.service.ts`
- Test: `apps/server-agent/src/services/llm-call.service.spec.ts`

- [ ] **Step 1：写失败测试**

末尾追加：

```ts
it("deleteAfter 删 createdAt > cutoff 的 LLM 调用", async () => {
  await service.record({
    sessionId: "s1",
    messageId: "m1",
    providerType: "p",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    durationMs: 1,
  });
  await new Promise((r) => setTimeout(r, 10));
  const cutoff = new Date();
  await new Promise((r) => setTimeout(r, 10));
  await service.record({
    sessionId: "s1",
    messageId: "m2",
    providerType: "p",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    durationMs: 1,
  });
  await service.deleteAfter("s1", cutoff);
  const rows = await service.listBySession("s1");
  expect(rows.map((r) => r.messageId)).toEqual(["m1"]);
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm jest apps/server-agent/src/services/llm-call.service.spec.ts 2>&1 | tail -10
```

Expected：`deleteAfter is not a function`。

- [ ] **Step 3：实现**

编辑 `apps/server-agent/src/services/llm-call.service.ts`：

a) import 加 MoreThan：

```ts
import { In, MoreThan, Repository } from "typeorm";
```

b) 在 `deleteBySession` 后追加：

```ts
/**
 * 删某会话内 createdAt > cutoff 的所有 LLM 调用记录。供「重生成」剪 usage 用。
 */
async deleteAfter(sessionId: string, cutoff: Date): Promise<void> {
  await this.llmCallRepo.delete({
    sessionId,
    createdAt: MoreThan(cutoff),
  });
}
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm jest apps/server-agent/src/services/llm-call.service.spec.ts 2>&1 | tail -10
```

Expected：PASS。

- [ ] **Step 5：commit**

```bash
git add apps/server-agent/src/services/llm-call.service.ts \
        apps/server-agent/src/services/llm-call.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(llm-call): deleteAfter

供「重生成」端点剪 usage：严格 > cutoff createdAt 删后续 LLM 调用记录。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：GraphService.cutMessagesAfter

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts`

- [ ] **Step 1：实现（无单测 —— 这是 LangGraph 集成层，沿用现有 sanitizeOrphanToolCalls 同款风格）**

编辑 `libs/agent/src/graph/graph.service.ts`，在 `sanitizeOrphanToolCalls` 私有方法**之后**追加 public 方法：

```ts
/**
 * 从 checkpointer state 里剪掉 cutoff message 之后的所有消息（含 assistant
 * / tool / 后续轮 user）。cutoff 本身保留。供「重生成」流程用。
 *
 * 用 RemoveMessage + updateState（messages reducer 已支持 RemoveMessage）。
 * 找不到 cutoff message 时静默 no-op，让上层决定怎么处理。
 */
async cutMessagesAfter(
  threadId: ThreadId,
  cutoffMessageId: string,
): Promise<void> {
  const snapshot = await this.graph.getState({
    configurable: { thread_id: threadId },
  });
  const msgs = (snapshot.values as GraphState | undefined)?.messages ?? [];
  const idx = msgs.findIndex((m) => m.id === cutoffMessageId);
  if (idx < 0) return;
  const toRemove = msgs
    .slice(idx + 1)
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
  if (toRemove.length === 0) return;
  console.warn(
    `[graph] cutMessagesAfter thread=${threadId} cutoff=${cutoffMessageId} 剪掉 ${toRemove.length} 条后续消息：${toRemove.join(", ")}`,
  );
  await this.graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: toRemove.map((id) => new RemoveMessage({ id })) },
  );
}
```

注意 `RemoveMessage` 已在 commit d751ead 加过 import；如未在则补：

```ts
import {
  AIMessageChunk,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
} from "@langchain/core/messages";
```

- [ ] **Step 2：typecheck**

```bash
pnpm --filter @meshbot/agent typecheck
```

Expected：exit 0。

- [ ] **Step 3：commit**

```bash
git add libs/agent/src/graph/graph.service.ts
git commit -m "$(cat <<'EOF'
feat(graph): cutMessagesAfter —— 剪 checkpointer 指定 message 之后的所有消息

供「重生成」流程用：找到 cutoff message index，用 RemoveMessage 批量剪后
续所有有 id 的消息（messages reducer 已支持）。cutoff 本身保留。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：SessionService.regenerateAfter

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`

- [ ] **Step 1：写失败测试**

`session.service.spec.ts` 顶部 import 加（若未存在）：

```ts
import { BadRequestException } from "@nestjs/common";
```

测试用现有 beforeEach 装的所有 service。在文件末尾追加：

```ts
describe("regenerateAfter", () => {
  async function seedSession(sessionId: string): Promise<void> {
    const ds = (service as unknown as { __ds: DataSource }).__ds;
    // user 消息
    await ds.query(
      `INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', '你好', datetime('now', '-3 seconds'))`,
      [`u1-${sessionId}`, sessionId],
    );
    // assistant 消息
    await ds.query(
      `INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', '回复', datetime('now', '-2 seconds'))`,
      [`a1-${sessionId}`, sessionId],
    );
    // 第二条 user
    await ds.query(
      `INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', '再问', datetime('now', '-1 seconds'))`,
      [`u2-${sessionId}`, sessionId],
    );
    // llm_calls
    await ds.query(
      `INSERT INTO llm_calls (id, session_id, message_id, provider_type, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, duration_ms, created_at) VALUES (?, ?, 'a1', 'p', 'm', 1, 1, 2, 0, 0, 0, 1, datetime('now', '-2 seconds'))`,
      [`call-a1-${sessionId}`, sessionId],
    );
  }

  it("regenerateAfter 删 cutoff 之后所有 session_messages + llm_calls", async () => {
    const { sessionId } = await service.createSession({ content: "x" });
    await seedSession(sessionId);
    await service.regenerateAfter(sessionId, `u1-${sessionId}`);
    const ds = (service as unknown as { __ds: DataSource }).__ds;
    const remain = await ds.query(
      `SELECT id FROM session_messages WHERE session_id = ? ORDER BY created_at`,
      [sessionId],
    );
    expect(remain.map((r: { id: string }) => r.id)).toEqual([
      `u1-${sessionId}`,
    ]);
    const calls = await ds.query(
      `SELECT id FROM llm_calls WHERE session_id = ?`,
      [sessionId],
    );
    expect(calls).toHaveLength(0);
  });

  it("regenerateAfter 不存在 messageId 抛 NotFoundException", async () => {
    const { sessionId } = await service.createSession({ content: "x" });
    await expect(
      service.regenerateAfter(sessionId, "nope"),
    ).rejects.toThrow(NotFoundException);
  });

  it("regenerateAfter messageId 不属于该 session 抛 NotFoundException", async () => {
    const a = await service.createSession({ content: "a" });
    const b = await service.createSession({ content: "b" });
    await seedSession(a.sessionId);
    await expect(
      service.regenerateAfter(b.sessionId, `u1-${a.sessionId}`),
    ).rejects.toThrow(NotFoundException);
  });

  it("regenerateAfter role != user 抛 BadRequestException", async () => {
    const { sessionId } = await service.createSession({ content: "x" });
    await seedSession(sessionId);
    await expect(
      service.regenerateAfter(sessionId, `a1-${sessionId}`),
    ).rejects.toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm jest apps/server-agent/src/services/session.service.spec.ts -t regenerateAfter 2>&1 | tail -20
```

Expected：4 个 case fail（方法不存在 / DI 没注 GraphService）。

beforeEach 需要给 SessionService 注入 GraphService 假替身 —— 在 spec 顶部加：

```ts
import { GraphService } from "@meshbot/agent";
```

把 beforeEach 里创建 service 那段改成：

```ts
// 假 GraphService：cutMessagesAfter 只记调用
const fakeGraph = {
  __cuts: [] as Array<{ threadId: string; cutoff: string }>,
  async cutMessagesAfter(threadId: string, cutoffMessageId: string) {
    this.__cuts.push({ threadId, cutoff: cutoffMessageId });
  },
};
service = new SessionService(
  ds.getRepository(Session),
  ds.getRepository(PendingMessage),
  llmCalls,
  sessionMessages,
  checkpointer,
  fakeGraph as unknown as GraphService,
);
(service as unknown as { __ds: DataSource; __graph: typeof fakeGraph }).__ds = ds;
(service as unknown as { __ds: DataSource; __graph: typeof fakeGraph }).__graph = fakeGraph;
```

并在 regenerateAfter 第一个 case 末尾断言：

```ts
const graph = (service as unknown as { __graph: { __cuts: Array<{ threadId: string; cutoff: string }> } }).__graph;
expect(graph.__cuts).toEqual([{ threadId: sessionId, cutoff: `u1-${sessionId}` }]);
```

- [ ] **Step 3：实现 SessionService 加 graph 依赖 + regenerateAfter**

编辑 `apps/server-agent/src/services/session.service.ts`：

a) 顶部 import 加：

```ts
import { GraphService } from "@meshbot/agent";
import { BadRequestException } from "@nestjs/common";
```

（注意现有 `@nestjs/common` import 已经有 `ConflictException, Injectable, NotFoundException`，把 BadRequestException 合并。）

b) constructor 加最后一个参数：

```ts
constructor(
  @InjectRepository(Session)
  private readonly sessionRepo: Repository<Session>,
  @InjectRepository(PendingMessage)
  private readonly pendingRepo: Repository<PendingMessage>,
  private readonly llmCalls: LlmCallService,
  private readonly sessionMessages: SessionMessageService,
  private readonly checkpointer: CheckpointerCleanupService,
  private readonly graph: GraphService,
) {}
```

c) 在 `deleteSession` 之后追加：

```ts
/**
 * 重生成入口：找到 user 消息后，删该消息后的所有 session_messages /
 * llm_calls / checkpointer state。cutoff user 消息本身保留，调用方接着
 * 调 runner.kickResume 触发 LLM 重跑。
 *
 * 不删 pending_messages：该 user 消息已 processed；pending 表是独立的
 * 入队队列，与 checkpointer state 解耦。
 */
async regenerateAfter(
  sessionId: string,
  messageId: string,
): Promise<void> {
  await this.findSessionOrFail(sessionId);
  const msg = await this.sessionMessages.findByIdOrFail(messageId);
  if (msg.sessionId !== sessionId) {
    throw new NotFoundException(
      `SessionMessage ${messageId} not in session ${sessionId}`,
    );
  }
  if (msg.role !== "user") {
    throw new BadRequestException("仅 user 消息支持重生成");
  }
  await this.sessionMessages.deleteAfter(sessionId, msg.createdAt);
  await this.llmCalls.deleteAfter(sessionId, msg.createdAt);
  await this.graph.cutMessagesAfter(sessionId, messageId);
}
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm jest apps/server-agent/src/services/session.service.spec.ts 2>&1 | tail -10
```

Expected：全部 PASS。

- [ ] **Step 5：fences**

```bash
pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo
```

Expected：0 finding。SessionService 跨 lib 注入 GraphService 是 service → service 调用，repo fence 允许。

- [ ] **Step 6：commit**

```bash
git add apps/server-agent/src/services/session.service.ts \
        apps/server-agent/src/services/session.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(session): regenerateAfter 编排删三处 + checkpointer 剪

供「重生成」端点用：findByIdOrFail 拿 cutoff createdAt → deleteAfter 删
session_messages / llm_calls → graph.cutMessagesAfter 剪 checkpointer state。
不删 pending_messages（独立队列）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5：RunnerService.kickResume

**Files:**
- Modify: `apps/server-agent/src/services/runner.service.ts`
- Test: `apps/server-agent/src/services/runner.service.spec.ts`

- [ ] **Step 1：写失败测试**

`runner.service.spec.ts` 末尾追加：

```ts
it("kickResume：不 claim pending，直接 resume 跑一次", async () => {
  const sess = fakeSessionService();
  const emitter = new EventEmitter2();
  const events: string[] = [];
  emitter.onAny((name) => events.push(String(name)));
  const llmCalls = fakeLlmCallService();
  // 注意：不 enqueue 任何 pending 消息
  const runner = new RunnerService(
    sess as never,
    fakeGraphService() as never,
    emitter,
    llmCalls as never,
    fakeSessionMessageService() as never,
  );
  await runner.kickResumeAndWait("s1");
  // resumeStream fake 产 msg-r chunk + assistant_done + usage + done
  expect(events).toContain("run.done");
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm jest apps/server-agent/src/services/runner.service.spec.ts -t kickResume 2>&1 | tail -10
```

Expected：`runner.kickResumeAndWait is not a function`。

- [ ] **Step 3：实现**

编辑 `apps/server-agent/src/services/runner.service.ts`，在 `kickRetryAndWait` 之后追加：

```ts
/**
 * 触发 resume：不 claim pending_messages，直接走 resumeStream（checkpointer
 * 现有 state 重新跑一轮）。供「重生成」用 —— 该 user 消息已是 checkpointer
 * 最后一条，resume 会从该点重新调 LLM。
 *
 * running 哨兵防双 kick。runOnce 抛错时记录日志后退出，不无限循环。
 */
kickResume(sessionId: string): void {
  if (this.running.has(sessionId)) return;
  void this.kickResumeAndWait(sessionId).catch((err) => {
    this.logger.error(`resume loop crashed for ${sessionId}`, err);
  });
}

async kickResumeAndWait(sessionId: string): Promise<void> {
  if (this.running.has(sessionId)) return;
  this.running.add(sessionId);
  await this.sessions.setStatus(sessionId, "running");
  try {
    await this.runOnce(sessionId, [], true);
  } catch (err) {
    this.logger.warn(`resume runOnce 失败：${sessionId}`, err);
  } finally {
    this.running.delete(sessionId);
    await this.sessions.setStatus(sessionId, "idle");
  }
}
```

`runOnce(sessionId, [], true)` 安全：`markProcessed(ids)` 已防御空数组（session.service.ts:194）；`for (const event of stream)` 里 `event.kind === "human"` 仅在 batch 非空触发；其余事件按 resume 流走。

- [ ] **Step 4：跑测试看通过**

```bash
pnpm jest apps/server-agent/src/services/runner.service.spec.ts 2>&1 | tail -10
```

Expected：全部 PASS。

- [ ] **Step 5：commit**

```bash
git add apps/server-agent/src/services/runner.service.ts \
        apps/server-agent/src/services/runner.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(runner): kickResume —— 不依赖 pending 表的 resume 触发

供「重生成」用。runOnce(batch=[], resume=true) 安全：markProcessed
已防御空数组，human 事件仅 batch 非空时 emit。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6：Controller 端点

**Files:**
- Modify: `apps/server-agent/src/controllers/session.controller.ts`

- [ ] **Step 1：实现**

编辑 `apps/server-agent/src/controllers/session.controller.ts`，在已有的 `@Post(":id/retry")` 之后追加：

```ts
/**
 * 从某条 user 消息重生成：删该消息后的所有 session_messages / llm_calls /
 * checkpointer state，然后 resume 触发 LLM 重跑该 user 消息。
 *
 * 失败 user 消息也走这里 —— 此时后面没东西可删，等价于纯 resume。
 */
@Post(":sessionId/messages/:messageId/regenerate")
async regenerate(
  @Param("sessionId") sessionId: string,
  @Param("messageId") messageId: string,
): Promise<{ regenerated: true }> {
  await this.sessions.regenerateAfter(sessionId, messageId);
  this.runner.kickResume(sessionId);
  return { regenerated: true };
}
```

注意：路由名 `:sessionId` 而不是 `:id` —— 现有控制器其他端点用 `:id`，但这里有两个 param 必须区分。Express 路由参数名无副作用，只是函数 arg 名对应。

- [ ] **Step 2：typecheck**

```bash
pnpm --filter @meshbot/server-agent typecheck
```

Expected：exit 0。

- [ ] **Step 3：手测**

启 server-agent：

```bash
pnpm dev:server-agent
```

另开终端：

```bash
# 1. 创会话
SID=$(curl -sX POST localhost:3100/api/sessions -H 'Content-Type: application/json' -d '{"content":"你好"}' | jq -r .data.sessionId)
echo "session: $SID"

# 2. 等 LLM 跑完（看后端 log "runOnce done"）
sleep 5

# 3. 拿首条 user message id
UID=$(curl -s "localhost:3100/api/sessions/$SID/history" | jq -r '.data.messages[] | select(.role=="user") | .id' | head -1)
echo "user msg: $UID"

# 4. 重生成
curl -sX POST "localhost:3100/api/sessions/$SID/messages/$UID/regenerate" | jq .

# 5. 等几秒再查 history，应该有新 assistant 回复
sleep 5
curl -s "localhost:3100/api/sessions/$SID/history" | jq '.data.messages[] | {id, role, content: (.content | .[0:20])}'
```

Expected：history 第二次返回的 assistant 消息 id 跟第一次不一样（说明真的重跑了）。

- [ ] **Step 4：commit**

```bash
git add apps/server-agent/src/controllers/session.controller.ts
git commit -m "$(cat <<'EOF'
feat(session): POST /messages/:messageId/regenerate 端点

调 sessions.regenerateAfter 删三处 + runner.kickResume 触发 resume 重跑。
失败 user 消息走同一路径（后面没东西可删 = 纯 resume）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7：前端 REST client

**Files:**
- Modify: `apps/web-agent/src/rest/session.ts`

- [ ] **Step 1：加函数**

末尾追加：

```ts
/** 从某条 user 消息重新生成（删后面 + 重跑）。 */
export async function regenerateMessage(
  sessionId: string,
  messageId: string,
): Promise<{ regenerated: true }> {
  const { data } = await apiClient.post<{ regenerated: true }>(
    `/api/sessions/${sessionId}/messages/${messageId}/regenerate`,
    {},
  );
  return data;
}
```

- [ ] **Step 2：rest/index.ts 加 re-export（如果用 barrel）**

```bash
grep -n "export.*from.*session" apps/web-agent/src/rest/index.ts
```

若有 named re-export 列表，加 `regenerateMessage`。若是 `export * from "./session"`，无需改。

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：exit 0。

- [ ] **Step 4：commit**

```bash
git add apps/web-agent/src/rest/session.ts apps/web-agent/src/rest/index.ts
git commit -m "$(cat <<'EOF'
feat(web-agent): rest 加 regenerateMessage

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8：UserMessageActions 组件

**Files:**
- Create: `apps/web-agent/src/components/session/user-message-actions.tsx`

- [ ] **Step 1：实现**

新建 `apps/web-agent/src/components/session/user-message-actions.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import { Check, Copy, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { regenerateMessage } from "@/rest/session";

interface Props {
  sessionId: string;
  messageId: string;
  content: string;
  /** 失败状态：按钮默认可见（不需要 hover），label 「重试」。 */
  failed?: boolean;
  /** 会话有 inflight run：重试按钮 disabled，避免触发双 run。 */
  running?: boolean;
  /**
   * 触发重生成前的乐观截断：父组件从 timeline 移除该消息之后的所有 message。
   * 提供即时反馈，让用户不必等服务端响应才看到「之前的回复消失」。
   */
  onOptimisticCut: () => void;
  /** 失败时父组件可弹 toast / log。 */
  onError?: (err: unknown) => void;
}

/**
 * user 气泡下方的操作按钮组：复制 + 重生成。
 *
 * - hover 气泡才显（failed 状态默认显，引导用户重试）
 * - 重试请求飞行期间 spinner + disabled，避免双击
 * - copy 总是可点（无网络）
 */
export function UserMessageActions({
  sessionId,
  messageId,
  content,
  failed,
  running,
  onOptimisticCut,
  onError,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onError?.(err);
    }
  }, [content, onError]);

  const handleRegenerate = useCallback(async () => {
    if (busy || running) return;
    setBusy(true);
    onOptimisticCut();
    try {
      await regenerateMessage(sessionId, messageId);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }, [busy, running, sessionId, messageId, onOptimisticCut, onError]);

  return (
    <div
      className={cn(
        "mt-1 flex items-center gap-1.5 transition-opacity",
        failed ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    >
      <button
        type="button"
        onClick={handleCopy}
        title="复制"
        className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={handleRegenerate}
        disabled={busy || running}
        title={failed ? "重试" : "重新生成"}
        className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
```

- [ ] **Step 2：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：exit 0。

- [ ] **Step 3：commit**

```bash
git add apps/web-agent/src/components/session/user-message-actions.tsx
git commit -m "$(cat <<'EOF'
feat(web-agent): UserMessageActions 组件

user 气泡下方的复制 + 重生成按钮组。hover 才显（failed 时默认显）；
重试请求飞行 spinner + disabled；会话有 inflight 时按钮 disable。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9：message-list 接入 + 背景色

**Files:**
- Modify: `apps/web-agent/src/components/session/message-list.tsx`

- [ ] **Step 1：改 props 类型**

读 `apps/web-agent/src/components/session/message-list.tsx`。修改 `MessageListProps`：

```ts
interface MessageListProps {
  messages: TimelineMessage[];
  /** 当前会话 id。供 UserMessageActions 调 regenerate 端点用。 */
  sessionId: string;
  /** 会话是否有 inflight run。重试按钮按这个 disable。 */
  running: boolean;
  /**
   * 用户点重试时，父组件截断 timeline 到该消息（含），实现乐观反馈。
   */
  onRegenerateOptimisticCut: (messageId: string) => void;
  /** 按消息 ID 索引的单次 LLM 调用用量，仅 assistant 消息使用。 */
  usageByMessage?: Record<string, MessageUsage>;
}
```

**删除** 原有 `onRetry?: () => void;` prop。

- [ ] **Step 2：删函数签名里的 onRetry 解构，加新 prop**

```ts
export function MessageList({
  messages,
  sessionId,
  running,
  onRegenerateOptimisticCut,
  usageByMessage,
}: MessageListProps) {
```

- [ ] **Step 3：user 气泡 div 加 `group` 类，背景按 failed 上色**

找到现有的 user 气泡分支，把：

```tsx
<div
  className={cn(
    "text-sm leading-relaxed",
    m.role === "user"
      ? "bg-foreground/8 px-3.5 py-2 text-foreground whitespace-pre-wrap"
      : "text-foreground",
  )}
>
```

改成：

```tsx
<div
  className={cn(
    "text-sm leading-relaxed",
    m.role === "user"
      ? cn(
          "px-3.5 py-2 text-foreground whitespace-pre-wrap",
          m.failed ? "bg-destructive/8" : "bg-foreground/8",
        )
      : "text-foreground",
  )}
>
```

- [ ] **Step 4：删掉原「失败 [重试]」inline 段**

定位并删除整段：

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

- [ ] **Step 5：外层 user 容器加 `group` className**

找到 `.map((m) => (` 里渲染单条消息的最外层 `<div key={m.id} ...>`：

```tsx
<div
  key={m.id}
  className={cn(
    "flex max-w-[80%] flex-col gap-2",
    m.role === "user" ? "self-end items-end" : "self-start",
  )}
>
```

改成（加 `group`）：

```tsx
<div
  key={m.id}
  className={cn(
    "group flex max-w-[80%] flex-col gap-2",
    m.role === "user" ? "self-end items-end" : "self-start",
  )}
>
```

- [ ] **Step 6：user 气泡之后挂 `<UserMessageActions />`**

顶部 import：

```tsx
import { UserMessageActions } from "./user-message-actions";
```

在 user 气泡的渲染分支末尾（最外层 `</div>` 闭合**之前**）追加：

```tsx
{m.role === "user" && (
  <UserMessageActions
    sessionId={sessionId}
    messageId={m.id}
    content={m.content}
    failed={m.failed}
    running={running}
    onOptimisticCut={() => onRegenerateOptimisticCut(m.id)}
  />
)}
```

注意：UserMessageActions 应放在气泡 `</div>` **之外**、外层 `<div key={m.id}>` 闭合**之前**，与 toolCalls / reasoning 等同级。具体位置参考现有 reasoning / toolCalls 的渲染位置。

- [ ] **Step 7：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：exit 0。注意 session/page.tsx 的 `<MessageList />` 调用处会因 props 类型变化而报错 —— Task 10 修。

- [ ] **Step 8：暂不 commit**（页面级 callsite 还没改完，等 Task 10 一起 commit）

---

## Task 10：session/page 适配 MessageList 新 props

**Files:**
- Modify: `apps/web-agent/src/app/session/page.tsx`

- [ ] **Step 1：找到 MessageList 调用处**

```bash
grep -n "MessageList\|onRetry" apps/web-agent/src/app/session/page.tsx
```

预期：会看到 `<MessageList messages={messages} onRetry={...} usageByMessage={...} />` 类似一行。

- [ ] **Step 2：改 callsite**

把 `<MessageList ... />` 改成：

```tsx
<MessageList
  messages={messages}
  sessionId={sessionId!}
  running={running}
  onRegenerateOptimisticCut={(messageId) => {
    apply((prev) => {
      const idx = prev.findIndex((m) => m.id === messageId);
      if (idx < 0) return prev;
      return prev.slice(0, idx + 1);
    });
  }}
  usageByMessage={usageByMessage}
/>
```

**删除** `onRetry={...}` prop（如果存在）。注意：`sessionId!` —— session 页 mount 时已保证 sessionId 非空（effect 里 `if (!sessionId) router.replace("/")`），用 non-null assertion；如果当前 page.tsx 已经在 sessionId null 时 early return 渲染，那直接 `sessionId` 也行。

- [ ] **Step 3：检查原 onRetry 调用方是否还需要**

`onRetry` 之前用于 `retrySession(sessionId)`（重试 failed pending）。看 pending-list 那边是否单独有自己的 retry 入口 —— 应该是有的（pending 区有自己的重试按钮）。如果 MessageList 之外没有别的地方调 `retrySession`，可以删除相关 state；但**不在本 plan 范围**，保留 retry 函数定义即可。

```bash
grep -n "onRetry\|retrySession" apps/web-agent/src/app/session/page.tsx
```

确认仍被引用就不动。

- [ ] **Step 4：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：exit 0。

- [ ] **Step 5：commit（含 Task 9 + Task 10）**

```bash
git add apps/web-agent/src/components/session/message-list.tsx \
        apps/web-agent/src/app/session/page.tsx
git commit -m "$(cat <<'EOF'
feat(web-session): user 气泡接入 UserMessageActions + failed 背景色

message-list 删 onRetry prop（裁掉「失败 [重试]」inline），改用底部
UserMessageActions（hover-显，failed 时默认显）。user 气泡 failed 时
背景从 foreground/8 换 destructive/8。

外层加 group className 让 hover 触发子组件 opacity-100。session/page
传 sessionId / running / onRegenerateOptimisticCut（截断 timeline 实现
即时反馈）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11：e2e 手测 + final check

**Files:** 无代码改动，仅手测 + 跑全套测试。

- [ ] **Step 1：跑全套测试**

```bash
pnpm typecheck
pnpm test
```

Expected：typecheck 退出码 0；test 全部 PASS。

- [ ] **Step 2：跑围栏**

```bash
pnpm check
```

Expected：6 围栏 0 finding。

- [ ] **Step 3：浏览器手测**

启 server-agent + web-agent，浏览器 `http://localhost:3001`：

1. **正常重生成路径**：
   - 创会话「介绍下 React」→ 等 LLM 跑完 →
   - hover user 气泡 → 底部出现 copy + 重新生成按钮 →
   - 点重新生成 → 按钮转 spinner →
   - assistant 消息消失（乐观截断），随后新的流式输出开始 →
   - 完成后新 assistant 消息与旧的不同（验证真的重跑了）

2. **复制路径**：
   - hover user 气泡 → 点复制 →
   - 图标变 ✓ 2 秒后回到 Copy →
   - 粘贴板内容是 user 消息原文

3. **failed 路径**：
   - 发一条消息 → 主动断网 / 模拟 LLM 失败 →
   - user 气泡背景变浅红色 →
   - copy + 重试按钮**默认显示**（不需要 hover） →
   - 点重试 → spinner →
   - 接通后应能跑通

4. **inflight 期间**：
   - 当前会话有 LLM 还在跑时 →
   - 重试按钮 disabled（spinner / hover 都不能点）→
   - 复制按钮仍可点

5. **多轮重生成**：
   - 发 3 条消息（user1 → assistant1 → user2 → assistant2 → user3 → assistant3）
   - 重生成 user2 → assistant2/user3/assistant3 全消失，新 assistant2 出现

不通过的 case 写下来回到对应 task 修。

- [ ] **Step 4：无 commit**

---

## 自检（Self-Review）

**1. Spec 覆盖：**
- session_messages.deleteAfter + findByIdOrFail → Task 1 ✓
- llm_calls.deleteAfter → Task 2 ✓
- graph.cutMessagesAfter → Task 3 ✓
- session.regenerateAfter（含 inject GraphService）→ Task 4 ✓
- runner.kickResume → Task 5 ✓
- controller `/messages/:messageId/regenerate` → Task 6 ✓
- rest.regenerateMessage → Task 7 ✓
- UserMessageActions（copy + regenerate + busy spinner + failed 默认显 + running disable）→ Task 8 ✓
- message-list failed 背景色 + 删 inline 失败文字 + 挂 actions → Task 9 ✓
- session/page 新 props → Task 10 ✓
- 手测 → Task 11 ✓

**2. 占位扫描：**
- 无 TBD / TODO。每个步骤都有完整代码或具体命令。

**3. 类型一致性：**
- `regenerateAfter(sessionId, messageId)` 签名贯穿 Service + Controller + 调用方一致
- `cutMessagesAfter(threadId, cutoffMessageId)` 签名一致
- `deleteAfter(sessionId, cutoff: Date)` 签名一致（两个 service 同款）
- `kickResume(sessionId)` / `kickResumeAndWait(sessionId)` 命名与现有 `kickRetry` / `kickRetryAndWait` 对齐
- 前端 atom 的 messages 是 `TimelineMessage[]`；onRegenerateOptimisticCut 操作的是这同款数组 ✓

无问题。

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-user-message-copy-regenerate.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - 我按 task 派 subagent + 每 task 两轮 review

**2. Inline Execution** - 我在当前会话直接跑

**Which approach?**
