# 会话历史分页与上拉加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `GET /api/sessions/:id/history` 加 cursor 分页 + 引入 `session_messages` append-only 表（永不删的展示反面），前端用 IntersectionObserver 哨兵实现滚动到顶部自动加载更早消息，并保持视口位置不跳。

**Architecture:** Runner 在 emit `run.human` / `run.done` 同时双写 `session_messages` 表（fire-and-forget，写失败仅 log）。LLM context 仍由 LangGraph state 管，未来支持 summarize 不影响展示。`history` 接口从读 checkpointer 改为读 `session_messages` 表，支持 `?before=<msgId>&limit=50`；前端持有 `oldestMessageIdRef` + `hasMoreHistoryRef`，IO 哨兵 intersect 时调 fetchHistory(cursor) prepend 老消息并锚定 scrollTop。

**Tech Stack:** NestJS + TypeORM + SQLite (better-sqlite3，synchronize=true)；React/Next.js + Jotai；IntersectionObserver。

**Spec:** [docs/superpowers/specs/2026-05-23-session-history-pagination-design.md](../specs/2026-05-23-session-history-pagination-design.md)

---

## File Structure

**新增：**
- `apps/server-agent/src/entities/session-message.entity.ts` — SessionMessage entity（append-only）
- `apps/server-agent/src/services/session-message.service.ts` — recordUser / recordAssistant / listPage
- `apps/server-agent/src/services/session-message.service.spec.ts` — 6 个测试

**修改：**
- `libs/types-agent/src/session.ts` — HistoryQuerySchema + HistoryResponseSchema 重塑（hasMore、可选 inflight/sessionTotals、byMessage 始终返）
- `apps/server-agent/src/app.module.ts` — TypeOrmModule entities 列表加 SessionMessage
- `apps/server-agent/src/session.module.ts` — 注册 SessionMessage + SessionMessageService
- `apps/server-agent/src/services/llm-call.service.ts` — 加 listByMessageIds
- `apps/server-agent/src/services/runner.service.ts` — InflightRun 加 reasoning 累积；事件循环双写 session_messages
- `apps/server-agent/src/controllers/session.controller.ts` — history 改 cursor 分页响应
- `apps/server-agent/src/dto/session.dto.ts` — HistoryQueryDto（如果走 createZodDto 路径；否则用 @Query() 原生）
- `apps/web-agent/src/rest/session.ts` — fetchHistory 增 before 参数
- `apps/web-agent/src/components/layouts/app-shell-layout.tsx` — 暴露 scrollContainerRef（透传到滚动 div）
- `apps/web-agent/src/atoms/session-usage.ts` — 加 appendUsageByMessageAtom（合并 byMessage 子集）
- `apps/web-agent/src/app/session/page.tsx` — refs、loadMoreHistory、IO 哨兵、滚动锚定

**不变：**
- `apps/web-agent/src/components/session/message-list.tsx`（只渲染传入的 messages 数组，不感知分页）
- LangGraph checkpointer / `GraphService.getHistory`（保留但不再被 controller 调用）

---

## Task 1: SessionMessage entity

**Files:**
- Create: `apps/server-agent/src/entities/session-message.entity.ts`

- [ ] **Step 1: 新建文件**

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from "typeorm";

/**
 * 会话消息表（append-only，永不删）。
 *
 * 用作展示反面：与 LangGraph checkpointer 解耦，未来 LLM context 被 summarize
 * 压缩时不影响这里。所有 user / assistant / tool 消息都进此表。
 *
 * id 与 checkpointer 里 HumanMessage / AIMessage 的 id 对齐（user 消息亦是
 * pending_messages.id），三方一致便于关联查询和前后端去重。
 */
@Entity("session_messages")
@Index(["sessionId", "createdAt", "id"])
export class SessionMessage {
  /** 与 checkpointer / pending_messages.id 对齐。 */
  @PrimaryColumn()
  id!: string;

  /** 逻辑外键，无 DB 约束。 */
  @Column({ name: "session_id" })
  sessionId!: string;

  /** "user" | "assistant" | "system" | "tool"；本次仅 user/assistant 写入。 */
  @Column({ type: "varchar" })
  role!: "user" | "assistant" | "system" | "tool";

  @Column({ type: "text" })
  content!: string;

  /** 推理模型的思考过程（DeepSeek 等）；非推理 / 工具消息为 null。 */
  @Column({ type: "text", nullable: true })
  reasoning!: string | null;

  /** 工具调用参数（JSON-string），assistant 调工具时填；本次预留。 */
  @Column({ name: "tool_calls", type: "text", nullable: true })
  toolCalls!: string | null;

  /** tool role 时关联到上游 assistant 的某条 tool_call id；本次预留。 */
  @Column({ name: "tool_call_id", type: "varchar", nullable: true })
  toolCallId!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors（entity 还没被任何代码引用，但单独编译应通过）

- [ ] **Step 3: Commit**

```bash
git add apps/server-agent/src/entities/session-message.entity.ts
git commit -m "feat(session): SessionMessage entity（append-only 展示反面）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 注册 entity 到 app.module + session.module

**Files:**
- Modify: `apps/server-agent/src/app.module.ts`
- Modify: `apps/server-agent/src/session.module.ts`

- [ ] **Step 1: app.module.ts 加 import 和 entities 数组**

打开 `apps/server-agent/src/app.module.ts`，找到 import PendingMessage 的位置：

```ts
import { PendingMessage } from "./entities/pending-message.entity";
```

在它下方加：

```ts
import { SessionMessage } from "./entities/session-message.entity";
```

找到 `entities: [LlmCall, ModelConfig, Setting, User, Session, PendingMessage],`，改为：

```ts
entities: [LlmCall, ModelConfig, Setting, User, Session, PendingMessage, SessionMessage],
```

- [ ] **Step 2: session.module.ts 加 SessionMessage 到 TxTypeOrmModule.forFeature**

打开 `apps/server-agent/src/session.module.ts`。当前是：

```ts
import { LlmCall } from "./entities/llm-call.entity";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { LlmCallService } from "./services/llm-call.service";
import { RunnerService } from "./services/runner.service";
import { SessionService } from "./services/session.service";
```

加 SessionMessage import：

```ts
import { LlmCall } from "./entities/llm-call.entity";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { SessionMessage } from "./entities/session-message.entity";
import { LlmCallService } from "./services/llm-call.service";
import { RunnerService } from "./services/runner.service";
import { SessionMessageService } from "./services/session-message.service";
import { SessionService } from "./services/session.service";
```

把：

```ts
TxTypeOrmModule.forFeature([Session, PendingMessage, LlmCall]),
```

改为：

```ts
TxTypeOrmModule.forFeature([Session, PendingMessage, LlmCall, SessionMessage]),
```

把 `providers` 行：

```ts
providers: [SessionService, RunnerService, SessionGateway, LlmCallService],
```

改为：

```ts
providers: [
  SessionService,
  RunnerService,
  SessionGateway,
  LlmCallService,
  SessionMessageService,
],
```

把 `exports` 行：

```ts
exports: [SessionService, RunnerService, LlmCallService],
```

改为：

```ts
exports: [SessionService, RunnerService, LlmCallService, SessionMessageService],
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 失败，报 `Cannot find module './services/session-message.service'`（预期，下一个 task 创建该文件）

- [ ] **Step 4: Commit（即使 typecheck 失败也提交 —— 模块结构先就位）**

```bash
git add apps/server-agent/src/app.module.ts apps/server-agent/src/session.module.ts
git commit -m "chore(session): SessionMessage 注册到 app/session module

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

如果 pre-commit hook 卡因 typecheck，连 Task 3 一起做完再 commit（biome / 静态围栏不应卡）。

---

## Task 3: SessionMessageService — 写失败测试

**Files:**
- Create: `apps/server-agent/src/services/session-message.service.spec.ts`

- [ ] **Step 1: 新建测试文件**

参考 `session.service.spec.ts` 的 DataSource 引导模式。完整内容：

```ts
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { SessionMessage } from "../entities/session-message.entity";
import { SessionMessageService } from "./session-message.service";

describe("SessionMessageService", () => {
  let ds: DataSource;
  let service: SessionMessageService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [SessionMessage],
      synchronize: true,
    });
    await ds.initialize();
    service = new SessionMessageService(ds.getRepository(SessionMessage));
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** 给测试生成稳定递增 createdAt：直接绕过 @CreateDateColumn，用 raw insert。 */
  async function seed(
    sessionId: string,
    rows: Array<{ role: "user" | "assistant"; content: string; offsetMs: number }>,
  ): Promise<string[]> {
    const base = Date.now();
    const ids: string[] = [];
    for (const r of rows) {
      const id = randomUUID();
      ids.push(id);
      await ds.getRepository(SessionMessage).insert({
        id,
        sessionId,
        role: r.role,
        content: r.content,
        reasoning: null,
        toolCalls: null,
        toolCallId: null,
        createdAt: new Date(base + r.offsetMs),
      });
    }
    return ids;
  }

  it("recordUser 写入 user 消息", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "hi" });
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "u1" });
    expect(row).toMatchObject({
      id: "u1",
      sessionId: "s1",
      role: "user",
      content: "hi",
      reasoning: null,
    });
  });

  it("recordUser 重复 id 幂等（不抛、不覆盖）", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "first" });
    await service.recordUser({ id: "u1", sessionId: "s1", content: "second" });
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "u1" });
    expect(row?.content).toBe("first");
  });

  it("recordAssistant 写入 assistant + reasoning", async () => {
    await service.recordAssistant({
      id: "a1",
      sessionId: "s1",
      content: "你好",
      reasoning: "thinking...",
    });
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "a1" });
    expect(row).toMatchObject({
      role: "assistant",
      content: "你好",
      reasoning: "thinking...",
    });
  });

  it("listPage 无 before 返最新 N 条 + hasMore=true（>N 条数据）", async () => {
    await seed("s1", [
      { role: "user", content: "m1", offsetMs: 0 },
      { role: "assistant", content: "m2", offsetMs: 1 },
      { role: "user", content: "m3", offsetMs: 2 },
      { role: "assistant", content: "m4", offsetMs: 3 },
    ]);
    const res = await service.listPage("s1", { limit: 2 });
    expect(res.messages.map((m) => m.content)).toEqual(["m3", "m4"]);
    expect(res.hasMore).toBe(true);
  });

  it("listPage 有 before 返 before 之前的 N 条", async () => {
    const ids = await seed("s1", [
      { role: "user", content: "m1", offsetMs: 0 },
      { role: "assistant", content: "m2", offsetMs: 1 },
      { role: "user", content: "m3", offsetMs: 2 },
      { role: "assistant", content: "m4", offsetMs: 3 },
    ]);
    // before = m3（index 2）→ 应返 [m1, m2]
    const res = await service.listPage("s1", { before: ids[2], limit: 10 });
    expect(res.messages.map((m) => m.content)).toEqual(["m1", "m2"]);
    expect(res.hasMore).toBe(false);
  });

  it("listPage hasMore=false 当剩余 <= limit", async () => {
    await seed("s1", [
      { role: "user", content: "m1", offsetMs: 0 },
      { role: "assistant", content: "m2", offsetMs: 1 },
    ]);
    const res = await service.listPage("s1", { limit: 10 });
    expect(res.messages.map((m) => m.content)).toEqual(["m1", "m2"]);
    expect(res.hasMore).toBe(false);
  });

  it("listPage before 指向不属于 session 的 id → NotFoundException（防越权）", async () => {
    const aIds = await seed("sA", [
      { role: "user", content: "in-a", offsetMs: 0 },
    ]);
    await seed("sB", [{ role: "user", content: "in-b", offsetMs: 0 }]);
    await expect(
      service.listPage("sB", { before: aIds[0], limit: 10 }),
    ).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec jest apps/server-agent/src/services/session-message.service.spec.ts`
Expected: 全部 FAIL（模块找不到 `./session-message.service`）

- [ ] **Step 3: Commit（红测试）**

```bash
git add apps/server-agent/src/services/session-message.service.spec.ts
git commit -m "test(session-message): SessionMessageService 失败测试

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: SessionMessageService 实现

**Files:**
- Create: `apps/server-agent/src/services/session-message.service.ts`

- [ ] **Step 1: 新建文件**

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import { SessionMessage } from "../entities/session-message.entity";

/** 写 user 消息入参。 */
export interface RecordUserInput {
  id: string;
  sessionId: string;
  content: string;
}

/** 写 assistant 消息入参（含 reasoning）。 */
export interface RecordAssistantInput {
  id: string;
  sessionId: string;
  content: string;
  reasoning: string | null;
}

/** listPage 返回。 */
export interface SessionMessagePage {
  messages: SessionMessage[];
  hasMore: boolean;
}

/**
 * session_messages 表的归属 Service —— 展示反面 / 永不删。
 *
 * Runner 在 emit run.human / run.done 同时双写到此表（fire-and-forget）。
 * history 端点从此表读取并 cursor 分页，与 LangGraph checkpointer 解耦：未来
 * LLM context 被 summarize 压缩时，展示历史不受影响。
 */
@Injectable()
export class SessionMessageService {
  constructor(
    @InjectRepository(SessionMessage)
    private readonly repo: Repository<SessionMessage>,
  ) {}

  /**
   * 记录一条 user 消息。幂等：id 已存在视为成功，不覆盖原内容。
   * 单表写入，无需事务。
   */
  async recordUser(input: RecordUserInput): Promise<void> {
    const exists = await this.repo.findOneBy({ id: input.id });
    if (exists) return;
    await this.repo.insert({
      id: input.id,
      sessionId: input.sessionId,
      role: "user",
      content: input.content,
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
    });
  }

  /**
   * 记录一条 assistant 消息（含可选 reasoning）。幂等。
   */
  async recordAssistant(input: RecordAssistantInput): Promise<void> {
    const exists = await this.repo.findOneBy({ id: input.id });
    if (exists) return;
    await this.repo.insert({
      id: input.id,
      sessionId: input.sessionId,
      role: "assistant",
      content: input.content,
      reasoning: input.reasoning,
      toolCalls: null,
      toolCallId: null,
    });
  }

  /**
   * Cursor 分页：返回 sessionId 下早于 beforeMessageId 的最新 limit 条
   * （按 createdAt asc 排，前端按时间顺序展示）。
   *
   * 实现：先按 id 拿 before 锚点的 createdAt（若 before 给了），再
   * `WHERE sessionId AND createdAt < anchor ORDER BY createdAt DESC LIMIT (limit + 1)`，
   * 取 limit 条 + 用 limit+1 条判 hasMore。最后把数组 reverse 回 asc。
   */
  async listPage(
    sessionId: string,
    opts: { before?: string; limit: number },
  ): Promise<SessionMessagePage> {
    let anchorDate: Date | undefined;
    if (opts.before) {
      const anchor = await this.repo.findOneBy({ id: opts.before });
      if (!anchor || anchor.sessionId !== sessionId) {
        // 防越权：不属于该 session 的 id 一律 404，不暴露存在性
        throw new NotFoundException(
          `SessionMessage ${opts.before} not found in session ${sessionId}`,
        );
      }
      anchorDate = anchor.createdAt;
    }
    const rows = await this.repo.find({
      where: {
        sessionId,
        ...(anchorDate ? { createdAt: LessThan(anchorDate) } : {}),
      },
      order: { createdAt: "DESC" },
      take: opts.limit + 1,
    });
    const hasMore = rows.length > opts.limit;
    const slice = hasMore ? rows.slice(0, opts.limit) : rows;
    // reverse 回 asc（前端按时间顺序展示）
    slice.reverse();
    return { messages: slice, hasMore };
  }
}
```

- [ ] **Step 2: 运行测试，全部通过**

Run: `pnpm exec jest apps/server-agent/src/services/session-message.service.spec.ts`
Expected: 6 passed

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors（session.module.ts 现在能解析 SessionMessageService）

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/services/session-message.service.ts
git commit -m "feat(session): SessionMessageService（recordUser/recordAssistant/listPage）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: RunnerService 双写

**Files:**
- Modify: `apps/server-agent/src/services/runner.service.ts`

- [ ] **Step 1: import SessionMessageService**

文件顶部 import 区，找到：

```ts
import { LlmCallService } from "./llm-call.service";
import { SessionService } from "./session.service";
```

中间加：

```ts
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";
```

- [ ] **Step 2: constructor 注入**

找到 constructor：

```ts
constructor(
  private readonly sessions: SessionService,
  private readonly graph: GraphService,
  private readonly emitter: EventEmitter2,
  private readonly llmCalls: LlmCallService,
) {}
```

改为：

```ts
constructor(
  private readonly sessions: SessionService,
  private readonly graph: GraphService,
  private readonly emitter: EventEmitter2,
  private readonly llmCalls: LlmCallService,
  private readonly sessionMessages: SessionMessageService,
) {}
```

- [ ] **Step 3: InflightRun 接口加 reasoning 字段**

找到 InflightRun 接口定义：

```ts
interface InflightRun {
  messageId: string | null;
  content: string;
  status: "streaming" | "done" | "interrupted";
  abort: AbortController;
}
```

改为：

```ts
interface InflightRun {
  messageId: string | null;
  content: string;
  /** 推理内容累积（DeepSeek 等推理模型）；非推理模型保持空串。 */
  reasoning: string;
  status: "streaming" | "done" | "interrupted";
  abort: AbortController;
}
```

- [ ] **Step 4: 在 runOnce 内部，初始化 run.reasoning + 双写 user + 累积 reasoning + 双写 assistant**

找到 `runOnce` 方法（约 156-244 行）。具体修改：

**4a.** 找到 `const run: InflightRun = { ... };` —— 字段补 reasoning：

```ts
const run: InflightRun = {
  messageId: null,
  content: "",
  reasoning: "",
  status: "streaming",
  abort: new AbortController(),
};
```

**4b.** 找到 `if (event.kind === "human") { ... emit ... continue; }`，在 emit 后、continue 前增双写：

```ts
if (event.kind === "human") {
  if (!firstHumanLogged) {
    firstHumanLogged = true;
    this.logger.log(
      `runOnce first-human session=${sessionId} +${Date.now() - runStartedAt}ms`,
    );
  }
  this.emitter.emit(SESSION_WS_EVENTS.runHuman, {
    sessionId,
    messageId: event.messageId,
  });
  // 双写 session_messages（fire-and-forget，写失败仅 log）
  const content =
    batch.find((b) => b.id === event.messageId)?.content ?? "";
  this.sessionMessages
    .recordUser({ id: event.messageId, sessionId, content })
    .catch((err) =>
      this.logger.error(
        `session_messages.recordUser 失败 msg=${event.messageId}`,
        err,
      ),
    );
  continue;
}
```

**4c.** 找到 `if (event.kind === "reasoning") { ... emit ... continue; }`，在 emit 之前累加：

```ts
if (event.kind === "reasoning") {
  run.reasoning += event.delta;
  this.emitter.emit(SESSION_WS_EVENTS.runReasoning, {
    sessionId,
    messageId: event.messageId,
    delta: event.delta,
  });
  continue;
}
```

**4d.** 找到 done 路径（success path），紧跟 emit runDone 之后：

```ts
run.status = "done";
const streamEndedAt = Date.now();
await this.sessions.markProcessed(ids);
const markProcessedMs = Date.now() - streamEndedAt;
if (run.messageId) {
  this.emitter.emit(SESSION_WS_EVENTS.runDone, {
    sessionId,
    messageId: run.messageId,
    content: run.content,
  });
}
```

改为：

```ts
run.status = "done";
const streamEndedAt = Date.now();
await this.sessions.markProcessed(ids);
const markProcessedMs = Date.now() - streamEndedAt;
if (run.messageId) {
  this.emitter.emit(SESSION_WS_EVENTS.runDone, {
    sessionId,
    messageId: run.messageId,
    content: run.content,
  });
  // 双写 session_messages（fire-and-forget）
  const reasoning = run.reasoning ? run.reasoning : null;
  this.sessionMessages
    .recordAssistant({
      id: run.messageId,
      sessionId,
      content: run.content,
      reasoning,
    })
    .catch((err) =>
      this.logger.error(
        `session_messages.recordAssistant 失败 msg=${run.messageId}`,
        err,
      ),
    );
}
```

失败/中断路径**不写**（spec 已说明）。

- [ ] **Step 5: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors

- [ ] **Step 6: 跑现有 runner 相关测试（如果有）**

Run: `pnpm exec jest apps/server-agent/src/services/runner.service.spec.ts 2>/dev/null || echo "no runner spec"`

如果存在 spec 且失败，看错误信息：如果是因为 mock SessionMessageService 缺失，给 mock 加上空实现：

```ts
const sessionMessages = {
  recordUser: jest.fn().mockResolvedValue(undefined),
  recordAssistant: jest.fn().mockResolvedValue(undefined),
};
// 传给 new RunnerService(...)
```

- [ ] **Step 7: Commit**

```bash
git add apps/server-agent/src/services/runner.service.ts
git commit -m "feat(runner): 双写 session_messages + 累积 reasoning

run.human emit 时写 user 消息；run.done emit 时写 assistant（含累积的 reasoning）。
fire-and-forget，写失败仅 log，不阻塞 run。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: LlmCallService 加 listByMessageIds

**Files:**
- Modify: `apps/server-agent/src/services/llm-call.service.ts`

- [ ] **Step 1: 加方法**

找到文件末尾、`getSessionTotals` 方法之后、类闭合 `}` 之前，加上：

```ts
  /**
   * 按 messageId 批量查 LlmCall（用于历史分页本批的 byMessage 投影）。
   * 空数组直接返 []，不打数据库。
   */
  async listByMessageIds(messageIds: string[]): Promise<LlmCall[]> {
    if (messageIds.length === 0) return [];
    return this.llmCallRepo.find({
      where: { messageId: In(messageIds) },
    });
  }
```

- [ ] **Step 2: 加 In import**

文件顶部当前：

```ts
import { Repository } from "typeorm";
```

改为：

```ts
import { In, Repository } from "typeorm";
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/services/llm-call.service.ts
git commit -m "feat(llm-call): listByMessageIds 用于分页响应的 byMessage 投影

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: types-agent — HistoryQuery + HistoryResponse 重塑

**Files:**
- Modify: `libs/types-agent/src/session.ts`

- [ ] **Step 1: 加 HistoryQuerySchema**

在 `HistoryResponseSchema` 定义之前加：

```ts
/** GET /api/sessions/:id/history 查询参数。 */
export const HistoryQuerySchema = z.object({
  /** Cursor：上一批最早消息的 id；不传 = 拉最新一批。 */
  before: z.string().optional(),
  /** 每页条数，默认 50，硬上限 200。 */
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;
```

- [ ] **Step 2: 重塑 HistoryResponseSchema**

找到当前：

```ts
/** GET /api/sessions/:id/history 出参。 */
export const HistoryResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
  inflight: InflightSnapshotSchema.nullable(),
  usage: SessionUsageSchema,
});
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;
```

改为：

```ts
/**
 * GET /api/sessions/:id/history 出参。
 *
 * cursor 分页：messages 按 createdAt asc，hasMore 表示老消息是否还有。
 * 仅首次（before 未传）返 inflight + sessionTotals；翻页时不返。byMessage
 * 始终是本批 messages 对应的 LLM usage 投影，前端合并到 atom。
 */
export const HistoryResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
  hasMore: z.boolean(),
  inflight: InflightSnapshotSchema.nullable(),
  sessionTotals: SessionTotalsSchema.optional(),
  byMessage: z.record(z.string(), MessageUsageSchema),
});
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;
```

注意：移除 `SessionUsageSchema` 的嵌套引用。`SessionUsageSchema` 自身保留（不动），但 HistoryResponse 不再嵌它。

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/types-agent typecheck`
Expected: 0 errors（types-agent 自身没引用 SessionUsageSchema in HistoryResponse）

跑全包 typecheck：

Run: `pnpm turbo run typecheck --filter=@meshbot/server-agent --filter=@meshbot/web-agent`
Expected: **会失败**，server-agent 的 controller、web-agent 的 fetchHistory 仍按旧 shape 用。这是预期，Task 8 / Task 11 修。

- [ ] **Step 4: Commit**

```bash
git add libs/types-agent/src/session.ts
git commit -m "feat(types-agent): HistoryResponse 改 cursor 分页形

加 HistoryQuerySchema；HistoryResponse 加 hasMore，inflight/sessionTotals
改为可选（仅首次返），byMessage 始终返本批投影。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: SessionController.history 改 cursor 分页

**Files:**
- Modify: `apps/server-agent/src/controllers/session.controller.ts`

- [ ] **Step 1: imports**

顶部当前：

```ts
import { GraphService } from "@meshbot/agent";
import type {
  DeletePendingResponse,
  HistoryResponse,
  MessageUsage,
  PendingResponse,
} from "@meshbot/types-agent";
import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { AppendMessageDto, CreateSessionDto } from "../dto/session.dto";
import { LlmCallService } from "../services/llm-call.service";
import { RunnerService } from "../services/runner.service";
import { SessionService } from "../services/session.service";
```

改为：

```ts
import {
  type DeletePendingResponse,
  type HistoryResponse,
  HistoryQuerySchema,
  type MessageUsage,
  type PendingResponse,
} from "@meshbot/types-agent";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { AppendMessageDto, CreateSessionDto } from "../dto/session.dto";
import { LlmCallService } from "../services/llm-call.service";
import { RunnerService } from "../services/runner.service";
import { SessionMessageService } from "../services/session-message.service";
import { SessionService } from "../services/session.service";
```

注意：`GraphService` 不再需要（不再调 `graph.getHistory`）。但如果其它方法仍用，保留 import 和注入。先 grep 看：

Run: `grep "this.graph" apps/server-agent/src/controllers/session.controller.ts`

如果只在 history 方法里出现，可以从 constructor 移除 GraphService 注入和 import；否则保留。**实施时根据 grep 结果决定**。

- [ ] **Step 2: constructor 注入 SessionMessageService**

找到 constructor：

```ts
constructor(
  private readonly sessions: SessionService,
  private readonly runner: RunnerService,
  private readonly graph: GraphService,
  private readonly llmCalls: LlmCallService,
) {}
```

改为：

```ts
constructor(
  private readonly sessions: SessionService,
  private readonly runner: RunnerService,
  private readonly graph: GraphService,
  private readonly llmCalls: LlmCallService,
  private readonly sessionMessages: SessionMessageService,
) {}
```

- [ ] **Step 3: history 方法整体替换**

找到当前 `async history(@Param("id") id: string): Promise<HistoryResponse> { ... }`，整体替换为：

```ts
/**
 * 取会话历史（cursor 分页）。
 *
 * - 无 before：返最新 limit 条 + inflight + sessionTotals
 * - 有 before：返早于 before 的 limit 条；inflight 为 null、sessionTotals 不返
 * - byMessage：每次都返本批 messages 对应的 LLM usage 投影
 */
@Get(":id/history")
async history(
  @Param("id") id: string,
  @Query() rawQuery: Record<string, string>,
): Promise<HistoryResponse> {
  await this.sessions.findSessionOrFail(id);
  const { before, limit } = HistoryQuerySchema.parse(rawQuery);
  const page = await this.sessionMessages.listPage(id, { before, limit });

  const byMessage: Record<string, MessageUsage> = {};
  const calls = await this.llmCalls.listByMessageIds(
    page.messages.map((m) => m.id),
  );
  for (const c of calls) {
    byMessage[c.messageId] = {
      providerType: c.providerType,
      model: c.model,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      totalTokens: c.totalTokens,
      cacheReadTokens: c.cacheReadTokens,
      cacheCreationTokens: c.cacheCreationTokens,
      reasoningTokens: c.reasoningTokens,
      durationMs: c.durationMs,
    };
  }

  const isFirstPage = !before;
  return {
    messages: page.messages.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    })),
    hasMore: page.hasMore,
    inflight: isFirstPage ? this.runner.getInflight(id) : null,
    ...(isFirstPage
      ? { sessionTotals: await this.llmCalls.getSessionTotals(id) }
      : {}),
    byMessage,
  };
}
```

注意：当前 `HistoryMessage.role` 类型是 `"user" | "assistant" | "system"`，没有 "tool"。SessionMessage.role 可能是 tool（未来）。本次仅 user/assistant 写入，cast 是安全的；未来加 tool 时同步扩 HistoryMessage role。

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors

- [ ] **Step 5: 手测接口（dev server 起着的话）**

Run（一行）:
```bash
curl -sS "http://127.0.0.1:3100/api/sessions/nonexistent/history" | head -3
```
Expected: 404 或 errno 提示（session 不存在）

如果 dev server 没起，跳过手测。

- [ ] **Step 6: Commit**

```bash
git add apps/server-agent/src/controllers/session.controller.ts
git commit -m "feat(session): history 端点改 cursor 分页（before + limit）

读 session_messages 替代 checkpointer；返 hasMore + 本批 byMessage 投影；
首次额外返 inflight + sessionTotals。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 前端 REST client — fetchHistory 加 before 参数

**Files:**
- Modify: `apps/web-agent/src/rest/session.ts`

- [ ] **Step 1: 改函数签名**

找到当前：

```ts
/** 取会话已处理历史 + inflight。 */
export async function fetchHistory(
  sessionId: string,
): Promise<HistoryResponse> {
  const { data } = await apiClient.get<HistoryResponse>(
    `/api/sessions/${sessionId}/history`,
  );
  return data;
}
```

改为：

```ts
/**
 * 取会话历史（cursor 分页）。
 * - 不传 before：拉最新一批 + inflight + sessionTotals
 * - 传 before：拉早于该 messageId 的一批；inflight 为 null、sessionTotals 不返
 */
export async function fetchHistory(
  sessionId: string,
  before?: string,
): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (before) params.set("before", before);
  const qs = params.toString();
  const { data } = await apiClient.get<HistoryResponse>(
    `/api/sessions/${sessionId}/history${qs ? `?${qs}` : ""}`,
  );
  return data;
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: **会失败**，session/page.tsx 仍按旧 HistoryResponse shape 用（读 `history.usage`、缺 `hasMore`）。预期，Task 11 修。

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/rest/session.ts
git commit -m "feat(web-agent): fetchHistory 加 before cursor 参数

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: AppShellLayout 透传 scrollContainerRef

**Files:**
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`

- [ ] **Step 1: 加 prop + 透传 ref**

找到组件 props 类型定义（约文件顶部）。当前应该是：

```ts
interface AppShellLayoutProps {
  children: React.ReactNode;
  className?: string;
  // ... 其它可能已有的 props
}
```

加可选 `scrollContainerRef`:

```ts
interface AppShellLayoutProps {
  children: React.ReactNode;
  className?: string;
  /** 暴露内部滚动容器 ref，供子页面读取/操作 scrollTop（如分页锚定）。 */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  // ... 保留其它已有
}
```

找到内部滚动 div（line 168-177 附近）：

```tsx
<section className="relative flex min-w-0 flex-1 flex-col">
  <div
    className={cn(
      "flex min-h-0 flex-1 flex-col overflow-y-auto",
      className,
    )}
  >
    <div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col p-4 lg:px-10">
      {children}
    </div>
  </div>
</section>
```

把 div 加 ref：

```tsx
<section className="relative flex min-w-0 flex-1 flex-col">
  <div
    ref={scrollContainerRef}
    className={cn(
      "flex min-h-0 flex-1 flex-col overflow-y-auto",
      className,
    )}
  >
    <div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col p-4 lg:px-10">
      {children}
    </div>
  </div>
</section>
```

确保 props 解构包含 `scrollContainerRef`。

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 仍报 session/page.tsx 的旧 shape 错（Task 11 修）；本文件应过。

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "refactor(app-shell-layout): 暴露 scrollContainerRef 给子页面用

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Usage atom — appendUsageByMessage

**Files:**
- Modify: `apps/web-agent/src/atoms/session-usage.ts`

- [ ] **Step 1: 看现状**

Run: `cat apps/web-agent/src/atoms/session-usage.ts`

找到 `setInitialUsageAtom` 或类似把 usage 写入 atom 的 setter。需要加一个新 setter：合并新批 byMessage 到现有 record。

- [ ] **Step 2: 加 appendUsageByMessageAtom**

在文件末尾、所有现有 atom 定义之后加（变量名以现有风格为准；这里假设 record state 是 `usageByMessageAtom`，是 primitive atom，类型 `Record<string, MessageUsage>`）：

```ts
import type { MessageUsage } from "@meshbot/types-agent";

/**
 * 合并一批 byMessage 到 usageByMessageAtom。
 * 用于翻页时把老消息的 usage 投影合进展示。同 id 覆盖（不该重复）。
 */
export const appendUsageByMessageAtom = atom(
  null,
  (get, set, batch: Record<string, MessageUsage>) => {
    const current = get(usageByMessageAtom);
    set(usageByMessageAtom, { ...current, ...batch });
  },
);
```

**实施提示**：如果文件用了不同的 atom 风格（例如 jotai-tanstack-query 派生 atom），按现有风格写。读 line 1-50 决定 import 来源（jotai vs jotai/utils）。

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 仍报 session/page.tsx 错。

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/atoms/session-usage.ts
git commit -m "feat(atoms): appendUsageByMessage —— 翻页时合并 byMessage 投影

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: session page — 接入新 history 形 + IO 哨兵 + 滚动锚定

**Files:**
- Modify: `apps/web-agent/src/app/session/page.tsx`

最复杂的 task。逐项修改：

- [ ] **Step 1: imports**

新增/调整 imports：

```ts
import {
  appendUsageAtom,
  appendUsageByMessageAtom,
  resetUsageAtom,
  sessionTotalsAtom,
  setInitialUsageAtom,
  usageByMessageAtom,
} from "@/atoms/session-usage";
```

- [ ] **Step 2: scrollContainerRef + hasMore/oldestId refs**

找到现有 ref 声明（约 line 53-60，已有 `messagesRef` / `bottomRef` / `draft` / `chatInputRef`）。在其下方加：

```ts
const scrollContainerRef = useRef<HTMLDivElement>(null);
const oldestMessageIdRef = useRef<string | null>(null);
const hasMoreHistoryRef = useRef(true);
const loadingMoreRef = useRef(false);
const [hasMoreHistory, setHasMoreHistory] = useState(true);
const topSentinelRef = useRef<HTMLDivElement>(null);
```

`hasMoreHistory` state 镜像 ref，用于触发 IO 哨兵的渲染/卸载。

- [ ] **Step 3: 改首次 fetchHistory 的初始化逻辑**

找到 `void Promise.all([fetchHistory(sessionId), fetchPending(sessionId)]).then(...)`。修改如下：

**3a.** `fetchHistory(sessionId)` 调用不变（不传 before）。

**3b.** 在 then 内部，把现在读 `history.usage.sessionTotals` / `history.usage.byMessage` 的地方改为读新 shape：
- `setInitialUsage(history.usage)` 改为：
  ```ts
  if (history.sessionTotals) {
    setInitialUsage({
      sessionTotals: history.sessionTotals,
      byMessage: history.byMessage,
    });
  } else {
    // 不会进这里（首次必返 sessionTotals）；防御
    appendUsageByMessage(history.byMessage);
  }
  ```

  **实施提示**：先 grep `setInitialUsageAtom` 的实现签名，确认入参形状（如果 atom 设计为分别 set `sessionTotalsAtom` + `usageByMessageAtom`，调用方式按现状）。

**3c.** 记录 cursor + hasMore：

```ts
const ordered = history.messages;
oldestMessageIdRef.current = ordered[0]?.id ?? null;
hasMoreHistoryRef.current = history.hasMore;
setHasMoreHistory(history.hasMore);
```

- [ ] **Step 4: 加 appendUsageByMessage hook**

紧跟其它 useSetAtom 行：

```ts
const setInitialUsage = useSetAtom(setInitialUsageAtom);
const appendUsage = useSetAtom(appendUsageAtom);
const appendUsageByMessage = useSetAtom(appendUsageByMessageAtom);
const resetUsage = useSetAtom(resetUsageAtom);
```

- [ ] **Step 5: 加 loadMoreHistory callback**

在现有 callback 区（如 handleSend、handleRetry 附近）加：

```ts
/**
 * 滚动到顶部触发：拉早于当前最旧消息的下一批 history。
 * - 锚定视口：prepend 前后 scrollTop 自动补偿，使用户当前看的消息不动
 * - 并发去重：loadingMoreRef 期间忽略重复触发
 */
const loadMoreHistory = useCallback(async () => {
  if (!sessionId) return;
  if (!hasMoreHistoryRef.current) return;
  if (loadingMoreRef.current) return;
  const cursor = oldestMessageIdRef.current;
  if (!cursor) return;
  loadingMoreRef.current = true;
  const scroller = scrollContainerRef.current;
  const prevScrollHeight = scroller?.scrollHeight ?? 0;
  const prevScrollTop = scroller?.scrollTop ?? 0;
  try {
    const res = await fetchHistory(sessionId, cursor);
    apply((prev) => {
      const newMessages: TimelineMessage[] = res.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        ...(m.reasoning
          ? { reasoning: m.reasoning, reasoningDurationMs: 0 }
          : {}),
      }));
      // 去重：socket 抢先到的或本地已有的不重复 prepend
      const existingIds = new Set(prev.map((m) => m.id));
      const fresh = newMessages.filter((m) => !existingIds.has(m.id));
      return [...fresh, ...prev];
    });
    appendUsageByMessage(res.byMessage);
    oldestMessageIdRef.current = res.messages[0]?.id ?? cursor;
    hasMoreHistoryRef.current = res.hasMore;
    setHasMoreHistory(res.hasMore);
    // 锚定视口：等 DOM 完成 prepend 后补偿 scrollTop
    requestAnimationFrame(() => {
      if (!scroller) return;
      const newScrollHeight = scroller.scrollHeight;
      scroller.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    });
  } catch (err) {
    console.error("加载更早消息失败", err);
  } finally {
    loadingMoreRef.current = false;
  }
}, [sessionId, apply, appendUsageByMessage]);
```

- [ ] **Step 6: IO 哨兵 useEffect**

在 socket 注册 useEffect **之后**（不互相干扰）加新 useEffect：

```ts
// 顶部哨兵触发上拉加载更早历史
useEffect(() => {
  if (!hasMoreHistory) return;
  const sentinel = topSentinelRef.current;
  if (!sentinel) return;
  const io = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        void loadMoreHistory();
      }
    },
    { rootMargin: "100px" }, // 距顶 100px 内就提前触发
  );
  io.observe(sentinel);
  return () => io.disconnect();
}, [loadMoreHistory, hasMoreHistory]);
```

- [ ] **Step 7: 渲染哨兵 + 把 scrollContainerRef 传给 AppShellLayout**

找到当前 JSX：

```tsx
return (
  <AppShellLayout>
    <div className="flex w-full flex-1 flex-col">
      <MessageList
        messages={timelineMessages}
        onRetry={handleRetry}
        usageByMessage={usageByMessage}
      />
      <div ref={bottomRef} />
    </div>
```

改为：

```tsx
return (
  <AppShellLayout scrollContainerRef={scrollContainerRef}>
    <div className="flex w-full flex-1 flex-col">
      {hasMoreHistory && (
        <div
          ref={topSentinelRef}
          className="flex justify-center py-2 text-xs text-muted-foreground/60"
          aria-label="加载更早消息"
        >
          {loadingMoreRef.current ? "加载中…" : ""}
        </div>
      )}
      {!hasMoreHistory && timelineMessages.length > 0 && (
        <div className="py-2 text-center text-xs text-muted-foreground/40">
          会话开头
        </div>
      )}
      <MessageList
        messages={timelineMessages}
        onRetry={handleRetry}
        usageByMessage={usageByMessage}
      />
      <div ref={bottomRef} />
    </div>
```

**实施提示**：`loadingMoreRef.current` 是 ref，不触发 rerender，所以 "加载中…" 显示不会随状态自动更新。这里可有可无：可省（哨兵不显文字），或者改成 useState 镜像 loadingMore。简单起见用空字符串。

- [ ] **Step 8: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 0 errors

- [ ] **Step 9: Commit**

```bash
git add apps/web-agent/src/app/session/page.tsx
git commit -m "feat(session): 上拉加载更早历史（IO 哨兵 + 滚动锚定）

- 接入 cursor 分页响应（hasMore / sessionTotals 可选 / byMessage 本批）
- 顶部哨兵 IntersectionObserver 监听，rootMargin 100px 提前触发
- prepend 前后用 scrollHeight 差补偿 scrollTop，视口不跳
- 并发去重（loadingMoreRef）+ socket 抢先消息去重

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: 手测 + 最终验证

- [ ] **Step 1: 起 dev server**

Run（两个独立终端）:
```bash
pnpm dev:server-agent
pnpm dev:web-agent
```

- [ ] **Step 2: 端到端测试 — 新会话 + 多轮聊天**

1. 新建会话，连续发 60 条短消息（触发 limit=50 + hasMore=true）
2. 刷新页面
3. 期望：默认只渲染最新 50 条；顶部哨兵存在
4. 滚动到顶 → 自动加载更早 10 条（剩余）→ 顶部出现「会话开头」
5. 滚动期间观察视口位置：用户当前看的消息不应跳

- [ ] **Step 3: 端到端测试 — 摘要场景**（手测预演，本范围不实现 summarize）

1. 同上新会话发 60 条
2. 验证 session_messages 表行数 = 60 + 60（user + assistant），SQLite 直接查：
   ```bash
   sqlite3 ~/.meshbot/agent.db "select count(*) from session_messages where session_id='<id>';"
   ```
3. 验证 checkpointer 仍正常工作（LLM 后续轮次能看到上下文）

- [ ] **Step 4: 错误场景 — 网络断开**

1. dev 模式下停 server，前端滚到顶 → console 报错；哨兵保留可重试
2. 起回 server，重新滚到顶 → 加载成功

- [ ] **Step 5: 最终 typecheck + 单元测试**

```bash
pnpm turbo run typecheck --filter=@meshbot/server-agent --filter=@meshbot/web-agent --filter=@meshbot/types-agent
pnpm exec jest apps/server-agent/src/services/session-message.service.spec.ts
pnpm exec jest apps/server-agent/src/services/session.service.spec.ts
```

Expected: 全部 PASS

- [ ] **Step 6: 如有 bug 修复 + 单独 commit**

按发现的问题写补丁。

---

## Self-Review 笔记

**Spec 覆盖：**
- ✅ Entity（Task 1）+ Module 注册（Task 2）
- ✅ Service 写入 + 分页（Task 3 + 4，TDD 红→绿）
- ✅ Runner 双写 + reasoning 累积（Task 5）
- ✅ LlmCallService.listByMessageIds（Task 6）
- ✅ types-agent schema 重塑（Task 7）
- ✅ Controller cursor 分页（Task 8）
- ✅ 前端 client 加 before（Task 9）
- ✅ AppShellLayout 透传 ref（Task 10）
- ✅ Usage atom append（Task 11）
- ✅ session page IO 哨兵 + 锚定 + 接新 shape（Task 12）

**类型一致性：**
- `SessionMessage` entity 字段名（toolCalls、toolCallId）camelCase；DB 列名 snake_case（@Column name 指定）
- `recordUser({id, sessionId, content})` 在 Task 3/4/5 三处使用，名字一致
- `listPage(sessionId, { before, limit })` 签名 Task 3/4/8 一致
- `appendUsageByMessageAtom` 在 Task 11 定义、Task 12 用，名字一致
- `HistoryQuerySchema` Task 7 定义、Task 8 用，z.coerce.number 保证 `?limit=50` query string 能正确转 number

**Placeholder 扫描：** 无 TBD / 「类似 Task X」 / 不带代码的步骤。Task 11 的 "atom 风格按现状" + Task 8 的 "GraphService 注入若不再用可移除" 是明确的 grep-and-decide 指引，不是 placeholder。

**已知降级：**
- 不引入 toast；错误用 `console.error`
- 老会话不迁移（spec 已确认，用户测试用新会话）
- `loadingMoreRef` 不触发 rerender，哨兵"加载中…"文案显示不准；简化省略
