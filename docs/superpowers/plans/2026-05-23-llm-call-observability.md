# LLM 调用观测 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次 LLM 调用：控制台一行结构化日志、token 落库、WS 推前端；前端每条 assistant 回复显示单次 token，ChatInput 右下角显示会话累计。

**Architecture:** `libs/agent` 的 `runGraphStream` 在流末从累计 `AIMessageChunk.usage_metadata` 取出 token 明细，额外 yield 一个 `{ kind: "usage", ... }` 事件（`StreamChunk` 升级为可辨识联合）。`RunnerService` 消费 usage 事件 → `LlmCallService.record` 落 `llm_calls` 表 + `Logger.log` 一行结构化文本 + emit `run.usage` → `SessionGateway` 转发到 socket room。前端 jotai `usageByMessage` / `sessionTotals` atoms 接收，`MessageList` 显示单次、`ChatInput` 显示累计。

**Tech Stack:** LangChain `AIMessageChunk.usage_metadata`（跨供应商标准化）、NestJS + TypeORM + SQLite、socket.io、jotai。

---

## 背景与约定（实施前必读）

- **仓库**：meshbot monorepo（pnpm + Turbo），当前分支 `main`。本特性动 `libs/agent`、`libs/types-agent`、`apps/server-agent`、`apps/web-agent`。
- **跨供应商靠 `usage_metadata`**：LangChain 0.3 已统一 OpenAI/Anthropic/Google/DeepSeek/Ollama 的 usage 上报为 `input_tokens` / `output_tokens` / `total_tokens` + `input_token_details.cache_read` / `cache_creation` + `output_token_details.reasoning`。供应商不上报某项 → 字段缺失或为 0，我们当 0 存。
- **`libs/agent` 不依赖 NestJS / TypeORM / Logger**：保持纯 LangGraph 编排层。观测的「落库 + 控制台 log + WS emit」全部在 `apps/server-agent` 的 `RunnerService` 里做。`GraphService` 只多 yield 一种事件。
- **测试**：server-agent / types-agent 用 Jest；`libs/agent` 用 vitest。
- **静态围栏**：改 `*.service.ts` / `*.controller.ts` / `*.gateway.ts` 后 commit 前跑 `pnpm check`。
- **提交信息**：中文，conventional commits，结尾 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。
- **格式**：commit 前 `pnpm format`。禁止在 `if` 前一行放注释。公开方法中文 JSDoc。不用 `--no-verify`。
- Pre-commit hook 跑围栏可能改 `docs/audits/*.json` / `scripts/check-*.ts` 的格式 —— 仅 `git add` 任务文件，不带这些无关改动。

## 文件结构总览

**新建：**
| 文件 | 职责 |
|---|---|
| `apps/server-agent/src/entities/llm-call.entity.ts` | `LlmCall` Entity |
| `apps/server-agent/src/migrations/1779200000000-LlmCallTable.ts` | `llm_calls` 表 DDL |
| `apps/server-agent/src/services/llm-call.service.ts` | `LlmCallService`（唯一归属）|
| `apps/web-agent/src/atoms/session-usage.ts` | jotai usage atoms |
| `apps/web-agent/src/lib/model-context-window.ts` | 模型 → context window 映射 |

**修改：**
| 文件 | 改动 |
|---|---|
| `libs/types-agent/src/session.ts` | `TokenBreakdown` / `MessageUsage` / `SessionTotals` / `SessionUsage` / `RunUsageEvent` schemas；`HistoryResponseSchema` 加 `usage`；`SESSION_WS_EVENTS.runUsage` |
| `libs/agent/src/graph/graph.service.ts` | `StreamChunk` 升级为可辨识联合；`runGraphStream` 末尾 yield usage 事件；构造时记 provider/model |
| `libs/agent/src/index.ts` | 导出新类型 |
| `apps/server-agent/src/app.module.ts` | 注册 `LlmCall` Entity |
| `apps/server-agent/src/session.module.ts` | 注册 `LlmCall` / `LlmCallService`；`RunnerService` 注入 `LlmCallService` |
| `apps/server-agent/src/services/runner.service.ts` | `runOnce` 区分 chunk/usage；落库 + Logger.log + emit runUsage |
| `apps/server-agent/src/services/runner.service.spec.ts` | fake graph yield usage；新增 usage 落库 + emit 用例 |
| `apps/server-agent/src/controllers/session.controller.ts` | `history` 端点带 `usage` 字段 |
| `apps/server-agent/src/ws/session.gateway.ts` | `@OnEvent(run.usage)` 转发 |
| `apps/web-agent/src/components/providers.tsx` | 无（jotai Provider 已存在）|
| `apps/web-agent/src/components/session/message-list.tsx` | 接受 `usageByMessage`；assistant 气泡底部显示单次 token |
| `apps/web-agent/src/components/common/chat-input.tsx` | Tooltip 扩展分项展示（输入/缓存/输出/推理/调用次数）|
| `apps/web-agent/src/app/session/page.tsx` | 接线 usage atoms：history 初始化、socket run.usage 增量、传给子组件 |

---

## Task 1：共享 schema（types-agent）

**Files:**
- Modify: `libs/types-agent/src/session.ts`
- Test: `libs/types-agent/src/session.spec.ts`

- [ ] **Step 1: 写失败测试**

读 `libs/types-agent/src/session.spec.ts`。在 `describe` 内追加：

```ts
  it("SessionUsageSchema 校验完整 usage 载荷", () => {
    const u = {
      sessionTotals: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        reasoningTokens: 0,
        callCount: 2,
      },
      byMessage: {
        "msg-1": {
          providerType: "deepseek",
          model: "deepseek-chat",
          inputTokens: 60,
          outputTokens: 30,
          totalTokens: 90,
          cacheReadTokens: 10,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          durationMs: 1200,
        },
      },
    };
    expect(SessionUsageSchema.parse(u)).toEqual(u);
  });

  it("RunUsageEventSchema 校验 socket 事件载荷", () => {
    const e = {
      sessionId: "s1",
      messageId: "msg-1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 60,
      outputTokens: 30,
      totalTokens: 90,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1200,
    };
    expect(RunUsageEventSchema.parse(e)).toEqual(e);
  });

  it("HistoryResponseSchema 含 usage 字段", () => {
    const r = {
      messages: [],
      inflight: null,
      usage: {
        sessionTotals: {
          inputTokens: 0, outputTokens: 0, totalTokens: 0,
          cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
          callCount: 0,
        },
        byMessage: {},
      },
    };
    expect(HistoryResponseSchema.parse(r)).toEqual(r);
  });

  it("SESSION_WS_EVENTS.runUsage 常量存在", () => {
    expect(SESSION_WS_EVENTS.runUsage).toBe("run.usage");
  });
```

确保测试文件顶部 import 含 `SessionUsageSchema` / `RunUsageEventSchema` / `HistoryResponseSchema` / `SESSION_WS_EVENTS`。前 3 个还不存在 —— 这是失败测试的预期。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/types-agent test -- session.spec`
Expected: FAIL（新 schema 未定义；SESSION_WS_EVENTS.runUsage 未定义）

- [ ] **Step 3: 改 session.ts**

读 `libs/types-agent/src/session.ts`。

在合适位置（与其他 schema 一起，放在 `RunErrorEventSchema` 之后）加：

```ts
/** 一次 LLM 调用的 token 明细（跨供应商统一字段；供应商不上报的项为 0）。 */
const TokenBreakdownSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  reasoningTokens: z.number(),
});

/** 单条 assistant 消息对应一次 LLM 调用的用量。 */
export const MessageUsageSchema = TokenBreakdownSchema.extend({
  providerType: z.string(),
  model: z.string(),
  durationMs: z.number(),
});
export type MessageUsage = z.infer<typeof MessageUsageSchema>;

/** 会话累计：所有 LLM 调用的求和。 */
export const SessionTotalsSchema = TokenBreakdownSchema.extend({
  callCount: z.number(),
});
export type SessionTotals = z.infer<typeof SessionTotalsSchema>;

/** 会话 usage 聚合 —— history 接口与前端 atom 共用。 */
export const SessionUsageSchema = z.object({
  sessionTotals: SessionTotalsSchema,
  byMessage: z.record(z.string(), MessageUsageSchema),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/** socket: run.usage 事件载荷（单条 LLM 调用完成）。 */
export const RunUsageEventSchema = MessageUsageSchema.extend({
  sessionId: z.string(),
  messageId: z.string(),
});
export type RunUsageEvent = z.infer<typeof RunUsageEventSchema>;
```

修改 `HistoryResponseSchema` —— 当前形如：
```ts
export const HistoryResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
  inflight: InflightSnapshotSchema.nullable(),
});
```
加 `usage` 字段：
```ts
export const HistoryResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
  inflight: InflightSnapshotSchema.nullable(),
  usage: SessionUsageSchema,
});
```

`SESSION_WS_EVENTS` 当前是个 `as const` 对象，加一个 key：
```ts
export const SESSION_WS_EVENTS = {
  ...
  runError: "run.error",
  runUsage: "run.usage",
} as const;
```
（按实际现有顺序在末尾追加。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/types-agent test -- session.spec`
Expected: PASS

- [ ] **Step 5: 构建**

Run: `pnpm --filter @meshbot/types-agent build`
Expected: 无错。

- [ ] **Step 6: 提交**

```bash
pnpm format
git add libs/types-agent/src/session.ts libs/types-agent/src/session.spec.ts
git commit -m "feat(types-agent): 新增 LLM 调用 usage schemas 与 run.usage 事件

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2：`LlmCall` Entity + 迁移

**Files:**
- Create: `apps/server-agent/src/entities/llm-call.entity.ts`
- Create: `apps/server-agent/src/migrations/1779200000000-LlmCallTable.ts`
- Modify: `apps/server-agent/src/app.module.ts`

无单测（声明式 Entity / DDL，由后续 Task 的 Service 测试间接覆盖）。

- [ ] **Step 1: 写 Entity**

`apps/server-agent/src/entities/llm-call.entity.ts`：

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * 一次 LLM 调用的观测记录。
 *
 * 每次 supervisor 节点跑完 model.stream 落一行；用于会话累计 token 与
 * 单条消息的 token 明细（前端展示 + 后期成本分析）。失败 run 不记录。
 */
@Entity("llm_calls")
export class LlmCall {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** 逻辑外键，无 DB 约束。 */
  @Column({ name: "session_id" })
  sessionId!: string;

  /** LangGraph AIMessage id，与 checkpointer assistant 消息对齐。 */
  @Column({ name: "message_id" })
  messageId!: string;

  @Column({ name: "provider_type", type: "varchar" })
  providerType!: string;

  @Column({ type: "varchar" })
  model!: string;

  @Column({ name: "input_tokens", type: "integer", default: 0 })
  inputTokens!: number;

  @Column({ name: "output_tokens", type: "integer", default: 0 })
  outputTokens!: number;

  @Column({ name: "total_tokens", type: "integer", default: 0 })
  totalTokens!: number;

  /** 缓存命中（低价）的 input tokens；供应商不上报则为 0。 */
  @Column({ name: "cache_read_tokens", type: "integer", default: 0 })
  cacheReadTokens!: number;

  /** 缓存首次写入的 input tokens；供应商不上报则为 0。 */
  @Column({ name: "cache_creation_tokens", type: "integer", default: 0 })
  cacheCreationTokens!: number;

  /** 推理（thinking）tokens；供应商不上报则为 0。 */
  @Column({ name: "reasoning_tokens", type: "integer", default: 0 })
  reasoningTokens!: number;

  @Column({ name: "duration_ms", type: "integer", default: 0 })
  durationMs!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
```

- [ ] **Step 2: 写迁移**

`apps/server-agent/src/migrations/1779200000000-LlmCallTable.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * llm_calls 表 —— 每次 LLM 调用的 token 观测记录。
 *
 * - IF NOT EXISTS 保证幂等
 * - 索引 (session_id) 加速会话累计 SUM 与 history 接口的 listBySession
 * - 列名 snake_case；TEXT/INTEGER/DATETIME
 */
export class LlmCallTable1779200000000 implements MigrationInterface {
  name = "LlmCallTable1779200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_calls" (
        "id"                     TEXT PRIMARY KEY NOT NULL,
        "session_id"             TEXT NOT NULL,
        "message_id"             TEXT NOT NULL,
        "provider_type"          TEXT NOT NULL,
        "model"                  TEXT NOT NULL,
        "input_tokens"           INTEGER NOT NULL DEFAULT 0,
        "output_tokens"          INTEGER NOT NULL DEFAULT 0,
        "total_tokens"           INTEGER NOT NULL DEFAULT 0,
        "cache_read_tokens"      INTEGER NOT NULL DEFAULT 0,
        "cache_creation_tokens"  INTEGER NOT NULL DEFAULT 0,
        "reasoning_tokens"       INTEGER NOT NULL DEFAULT 0,
        "duration_ms"            INTEGER NOT NULL DEFAULT 0,
        "created_at"             DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_llm_calls_session" ON "llm_calls" ("session_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_calls_session"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_calls"`);
  }
}
```

- [ ] **Step 3: 注册 Entity 到 TypeORM forRoot**

修改 `apps/server-agent/src/app.module.ts`。在 import 区加：
```ts
import { LlmCall } from "./entities/llm-call.entity";
```

`TypeOrmModule.forRoot({...})` 的 `entities` 数组 —— 当前类似 `[ModelConfig, PendingMessage, Session, Setting, User]`。在数组里加 `LlmCall`，保持字母序（在 `LlmCall` 处插入到 `ModelConfig` 之后或按字母位）。读实际 entities 数组，把 `LlmCall` 放在合适位置。

不要在这里改 `TxTypeOrmModule.forFeature` —— 那是 SessionModule 的事（Task 4）。

- [ ] **Step 4: 验证编译 + 迁移**

Run: `pnpm --filter @meshbot/server-agent build`
Expected: 无错。

启动一次 server-agent 让迁移执行：`pnpm dev:server-agent`，日志看到 `LlmCallTable1779200000000` 执行后 Ctrl-C。
Expected: 日志含迁移名；`~/.meshbot/agent.db` 或本仓库 `.meshbot/agent.db` 出现 `llm_calls` 表。

> 实施变通：如果 watch 服务器在 subagent 环境难控制，跳过启动 —— 构建 OK 即视为迁移结构合法（迁移文件本身是 SQL 字符串 + TypeORM 接口实现，编译过就语法对）。下次开发者启动时跑。

- [ ] **Step 5: 提交**

```bash
pnpm format
git add apps/server-agent/src/entities/llm-call.entity.ts apps/server-agent/src/migrations/1779200000000-LlmCallTable.ts apps/server-agent/src/app.module.ts
git commit -m "feat(session): 新增 LlmCall Entity 与 llm_calls 表迁移

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3：LlmCallService

**Files:**
- Create: `apps/server-agent/src/services/llm-call.service.ts`
- Test: `apps/server-agent/src/services/llm-call.service.spec.ts`

- [ ] **Step 1: 写失败测试**

`apps/server-agent/src/services/llm-call.service.spec.ts`（仿 `session.service.spec.ts` 的内存 DataSource 风格）：

```ts
import { DataSource } from "typeorm";
import { LlmCall } from "../entities/llm-call.entity";
import { LlmCallService } from "./llm-call.service";

describe("LlmCallService", () => {
  let ds: DataSource;
  let service: LlmCallService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [LlmCall],
      synchronize: true,
    });
    await ds.initialize();
    service = new LlmCallService(ds.getRepository(LlmCall));
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("record 落库一行", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1234,
    });
    const rows = await service.listBySession("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("m1");
    expect(rows[0].totalTokens).toBe(150);
  });

  it("getSessionTotals 求和各字段并计算 callCount", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 60,
      outputTokens: 30,
      totalTokens: 90,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      reasoningTokens: 0,
      durationMs: 800,
    });
    await service.record({
      sessionId: "s1",
      messageId: "m2",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 80,
      outputTokens: 40,
      totalTokens: 120,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      reasoningTokens: 5,
      durationMs: 1000,
    });
    const totals = await service.getSessionTotals("s1");
    expect(totals.inputTokens).toBe(140);
    expect(totals.outputTokens).toBe(70);
    expect(totals.totalTokens).toBe(210);
    expect(totals.cacheReadTokens).toBe(30);
    expect(totals.cacheCreationTokens).toBe(5);
    expect(totals.reasoningTokens).toBe(5);
    expect(totals.callCount).toBe(2);
  });

  it("getSessionTotals 对空会话返回全 0", async () => {
    const totals = await service.getSessionTotals("nonexistent");
    expect(totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      callCount: 0,
    });
  });

  it("listBySession 按 createdAt 升序", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
      durationMs: 0,
    });
    await service.record({
      sessionId: "s1",
      messageId: "m2",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
      durationMs: 0,
    });
    const rows = await service.listBySession("s1");
    expect(rows.map((r) => r.messageId)).toEqual(["m1", "m2"]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- llm-call.service`
Expected: FAIL（`LlmCallService` 模块不存在）

- [ ] **Step 3: 写 Service**

`apps/server-agent/src/services/llm-call.service.ts`：

```ts
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { LlmCall } from "../entities/llm-call.entity";

/** LlmCallService.record 入参 —— 单次 LLM 调用的完整观测数据。 */
export interface RecordLlmCallInput {
  sessionId: string;
  messageId: string;
  providerType: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  durationMs: number;
}

/** getSessionTotals 返回的会话累计（与 types-agent 的 SessionTotals 同形）。 */
export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  callCount: number;
}

/** LlmCall 表的归属 Service —— LLM 调用观测的数据层。 */
@Injectable()
export class LlmCallService {
  constructor(
    @InjectRepository(LlmCall)
    private readonly llmCallRepo: Repository<LlmCall>,
  ) {}

  /** 落一条 LLM 调用记录。 */
  async record(input: RecordLlmCallInput): Promise<void> {
    await this.llmCallRepo.save(this.llmCallRepo.create(input));
  }

  /** 列出某会话的全部 LLM 调用，按 createdAt 升序。 */
  listBySession(sessionId: string): Promise<LlmCall[]> {
    return this.llmCallRepo.find({
      where: { sessionId },
      order: { createdAt: "ASC" },
    });
  }

  /** 会话累计 —— 各 token 字段 SUM + callCount。 */
  async getSessionTotals(sessionId: string): Promise<SessionTotals> {
    const rows = await this.llmCallRepo.find({ where: { sessionId } });
    return rows.reduce<SessionTotals>(
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
  }
}
```

> 用应用层 reduce 而非 SQL `SUM(...)` GROUP BY —— 实现简单、可读，对单用户本地轨数据量足够；后期上规模可改 QueryBuilder + raw SUM。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- llm-call.service`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
pnpm format
git add apps/server-agent/src/entities/llm-call.entity.ts apps/server-agent/src/services/llm-call.service.ts apps/server-agent/src/services/llm-call.service.spec.ts
git commit -m "feat(session): LlmCallService 单次记录 + 会话累计

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

> 注意：Step 5 重复 git add 了 entity 文件 —— 它在 Task 2 已经提交。读 `git status` 只 stage 实际新文件（service + spec）。`llm-call.entity.ts` 应在 Task 2 commit 里。

修正：
```bash
pnpm format
git add apps/server-agent/src/services/llm-call.service.ts apps/server-agent/src/services/llm-call.service.spec.ts
git commit -m "feat(session): LlmCallService 单次记录 + 会话累计

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4：SessionModule 注册 LlmCall

**Files:**
- Modify: `apps/server-agent/src/session.module.ts`

- [ ] **Step 1: 读现状**

读 `apps/server-agent/src/session.module.ts`。当前注册 `Session` + `PendingMessage` Entity，提供 `SessionService` / `RunnerService` / `SessionGateway`。要把 `LlmCall` 加入 `TxTypeOrmModule.forFeature`，并 provide + export `LlmCallService`。

- [ ] **Step 2: 改 SessionModule**

在 import 区加：
```ts
import { LlmCall } from "./entities/llm-call.entity";
import { LlmCallService } from "./services/llm-call.service";
```

`@Module` 的 `imports` 里 `TxTypeOrmModule.forFeature([Session, PendingMessage])` 改为 `TxTypeOrmModule.forFeature([Session, PendingMessage, LlmCall])`。

`providers` 数组加 `LlmCallService`（位于现有 `SessionService`/`RunnerService` 旁）。
`exports` 数组加 `LlmCallService`（如果当前 exports 含 service 列表；若 module 只 exports 部分，按现状决定 —— `SessionController` 通过 `SessionModule` 自身可见，无需 export；但 future 跨模块使用考虑加 export 是良性）。

不改 `controllers`、`gateways` 之外的东西。

- [ ] **Step 3: 构建 + 围栏**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check`
Expected: 构建 OK；6 围栏 0 finding。`check:repo` 应识别 `LlmCall` 归属 `LlmCallService`（唯一 `@InjectRepository(LlmCall)`）。

- [ ] **Step 4: 提交**

```bash
pnpm format
git add apps/server-agent/src/session.module.ts
git commit -m "feat(session): SessionModule 注册 LlmCall + LlmCallService

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5：GraphService —— StreamChunk 升级 + yield usage 事件

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts`
- Modify: `libs/agent/src/index.ts`
- Test: `libs/agent/tests/unit/graph.service.test.ts`

`libs/agent` 用 **vitest**。

- [ ] **Step 1: 写失败测试**

读 `libs/agent/tests/unit/graph.service.test.ts`。它有一个 fake model（`stream()` 产 `AIMessageChunk`）。要让 fake 在末尾 emit 一个带 `usage_metadata` 的 chunk，并新增断言:`streamMessage` 在末尾 yield 一个 `kind:"usage"` 事件。

读现有 `beforeEach` 找 `fakeModel`。它的 `stream()` 是 async generator yielding `AIMessageChunk`s。修改 fake：把最后一个 yield 改为带 `usage_metadata`，或在末尾加一个 chunk 带 usage：

```ts
const fakeModel = {
  stream: async function* () {
    const msgId = `fake-msg-${++streamCall}`;
    yield new AIMessageChunk({ id: msgId, content: "你" });
    yield new AIMessageChunk({
      id: msgId,
      content: "好",
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_token_details: { cache_read: 3, cache_creation: 0 },
        output_token_details: { reasoning: 0 },
      },
    });
  },
  invoke: async () => new AIMessageChunk({ id: "fixed-msg-id", content: "你好" }),
};
```
（读实际 fake，按其结构调整。`usage_metadata` 是 LangChain `BaseMessage` 的官方字段；`AIMessageChunk` 构造参数支持它。）

在 `describe` 内加 streamMessage usage 用例：
```ts
  it("streamMessage 末尾 yield usage 事件含 token 明细", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    const events: any[] = [];
    for await (const ev of graphService.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      events.push(ev);
    }
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toBeTruthy();
    expect(usage.messageId).toBe(events[0].messageId); // 与 chunk 同 messageId
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(2);
    expect(usage.totalTokens).toBe(12);
    expect(usage.cacheReadTokens).toBe(3);
    expect(usage.providerType).toBe("fake");
    expect(usage.model).toBe("fake-model");
    expect(typeof usage.durationMs).toBe("number");
  });
```

> provider/model 需要 `GraphService` 知道当前用的是哪个 —— 测试构造的 `GraphService` 是通过 fake `modelProvider` 注入的，不走真实 `resolveModel`。最简：让 `GraphService` 多接受一个可选 `modelMeta?: { providerType, model }` 构造参数，测试传 `{ providerType: "fake", model: "fake-model" }`；生产路径在 `resolveModel` 里把 `ActiveModelConfig` 的 `providerType` / `model` 挂到一个内部字段供 `runGraphStream` 读。

调整测试 `beforeEach` 构造 `GraphService` 时加 `modelMeta`：
```ts
graphService = new GraphService(
  configService,
  promptService,
  () => Promise.resolve(fakeModel as never),
  { providerType: "fake", model: "fake-model" },
);
```

VERIFY：现有 `streamMessage` chunk 测试断言 `c.messageId === chunks[0].messageId` —— 新形态下 `events` 是混合 chunk/usage 联合，需要 `events.filter(e=>e.kind==="chunk")` 后再断言。读现有测试，按需调整以匹配 `StreamChunk` 升级为可辨识联合。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/agent test -- graph.service`
Expected: FAIL（usage 事件未实现，或 modelMeta 参数不被接受）

- [ ] **Step 3: 升级 StreamChunk 类型 + runGraphStream**

读 `libs/agent/src/graph/graph.service.ts`。

把 `StreamChunk` 接口替换为可辨识联合：
```ts
/** 流式 run 产出的事件：chunk = 单个 token；usage = 调用结束的 token 用量。 */
export type StreamChunk =
  | { kind: "chunk"; messageId: string; delta: string }
  | {
      kind: "usage";
      messageId: string;
      providerType: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      reasoningTokens: number;
      durationMs: number;
    };
```

GraphService 构造加可选 `modelMeta`：
```ts
@Injectable()
export class GraphService {
  // ...
  private modelMeta: { providerType: string; model: string };

  constructor(
    private configService: MeshbotConfigService,
    private promptService: PromptService,
    modelProvider?: ModelProvider,
    modelMeta?: { providerType: string; model: string },
  ) {
    // ... 原构造逻辑 ...
    this.modelMeta = modelMeta ?? { providerType: "unknown", model: "unknown" };
  }
```

`resolveModel`（生产路径）现在要把 ActiveModelConfig 的 `providerType` / `model` 挂到 `modelMeta`：
```ts
  private async resolveModel(): Promise<BaseChatModel> {
    const cfg = readActiveModelConfig(this.configService.getDatabasePath());
    if (!cfg) {
      throw new Error("...原文不变...");
    }
    this.modelMeta = { providerType: cfg.providerType, model: cfg.model };
    return (await createChatModel(cfg)) as BaseChatModel;
  }
```
（读 `resolveModel` 现有代码，加 modelMeta 赋值；保留 throw 等不变。）

重写 `runGraphStream`，每个 chunk yield `{ kind: "chunk", ... }`；累加最后一个 chunk 的 `usage_metadata` —— LangGraph `streamMode:"messages"` 末尾的 chunk 通常带 usage；用 `accumulated` 累加所有 chunk 在末尾读 `usage_metadata`：

```ts
  private async *runGraphStream(
    threadId: ThreadId,
    input: { messages: BaseMessage[] },
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const startedAt = Date.now();
    const stream = await this.graph.stream(input, {
      configurable: { thread_id: threadId },
      streamMode: "messages",
      signal,
    });
    let lastMessageId: string | null = null;
    let accumulated: AIMessageChunk | undefined;
    for await (const part of stream) {
      // streamMode:"messages" 产出 [BaseMessage, metadata] 元组
      const msg = Array.isArray(part) ? part[0] : part;
      if (!(msg instanceof AIMessageChunk)) continue;
      accumulated = accumulated === undefined ? msg : accumulated.concat(msg);
      const delta = typeof msg.content === "string" ? msg.content : "";
      if (!delta) continue;
      const messageId = msg.id ?? randomUUID();
      lastMessageId = messageId;
      yield { kind: "chunk", messageId, delta };
    }
    // 流结束：从累计 AIMessageChunk 读 usage_metadata
    const usage = accumulated?.usage_metadata;
    if (usage && lastMessageId) {
      yield {
        kind: "usage",
        messageId: lastMessageId,
        providerType: this.modelMeta.providerType,
        model: this.modelMeta.model,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        cacheReadTokens:
          (usage.input_token_details as { cache_read?: number } | undefined)
            ?.cache_read ?? 0,
        cacheCreationTokens:
          (usage.input_token_details as { cache_creation?: number } | undefined)
            ?.cache_creation ?? 0,
        reasoningTokens:
          (usage.output_token_details as { reasoning?: number } | undefined)
            ?.reasoning ?? 0,
        durationMs: Date.now() - startedAt,
      };
    }
  }
```

VERIFY：`AIMessageChunk.usage_metadata` 是 LangChain 0.3 的属性（`@langchain/core` 0.3 已支持）。`input_token_details` / `output_token_details` 是嵌套对象，部分供应商不上报 → 安全展开（`?.`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/agent test -- graph.service`
Expected: PASS。若现有 chunk-counting 测试用例因 `StreamChunk` 类型变化需要调整（如 `c.messageId` 直接访问需要先 `if (c.kind === "chunk")`），更新它们。

- [ ] **Step 5: 导出新类型**

`libs/agent/src/index.ts` —— 当前导出 `StreamChunk`（类型）。保持导出，因为它现在是联合类型，名字未变。检查无需追加 export。

- [ ] **Step 6: 全量 agent 测试 + 构建**

Run: `pnpm --filter @meshbot/agent test && pnpm --filter @meshbot/agent build`
Expected: 全 PASS / 构建无错。

> 注意：`StreamChunk` 类型从 `{messageId, delta}` 变成可辨识联合，`apps/server-agent` 的 `RunnerService` 当前迭代它直接访问 `chunk.messageId` / `chunk.delta` —— 编译会失败。这是 Task 6 修。本 Task 只保证 `libs/agent` 自己测试 + 构建通过。

- [ ] **Step 7: 提交**

```bash
pnpm format
git add libs/agent/src/graph/graph.service.ts libs/agent/tests/unit/graph.service.test.ts
git commit -m "feat(agent): StreamChunk 升级为联合 + runGraphStream 末尾 yield usage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6：RunnerService 消费 usage —— 落库 + log + emit run.usage

**Files:**
- Modify: `apps/server-agent/src/services/runner.service.ts`
- Test: `apps/server-agent/src/services/runner.service.spec.ts`

- [ ] **Step 1: 写失败测试**

读 `apps/server-agent/src/services/runner.service.spec.ts`。当前 `fakeGraphService` yield chunk-only。改 fake 让 `streamMessage` 在末尾 yield 一个 usage 事件，并加测试。

修改 `fakeGraphService`：
```ts
function fakeGraphService(opts?: { throwErr?: boolean }) {
  return {
    async *streamMessage() {
      if (opts?.throwErr) throw new Error("llm boom");
      yield { kind: "chunk", messageId: "msg-1", delta: "你" };
      yield { kind: "chunk", messageId: "msg-1", delta: "好" };
      yield {
        kind: "usage",
        messageId: "msg-1",
        providerType: "deepseek",
        model: "deepseek-chat",
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 3,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        durationMs: 100,
      };
    },
    async *resumeStream() {
      if (opts?.throwErr) throw new Error("llm boom");
      yield { kind: "chunk", messageId: "msg-r", delta: "重" };
      yield { kind: "chunk", messageId: "msg-r", delta: "试" };
      yield {
        kind: "usage",
        messageId: "msg-r",
        providerType: "deepseek",
        model: "deepseek-chat",
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        durationMs: 80,
      };
    },
  };
}
```

`RunnerService` 现在还需要注入 `LlmCallService` —— 给现有测试加一个 fake：
```ts
function fakeLlmCallService() {
  const records: unknown[] = [];
  return {
    records,
    async record(input: unknown) {
      records.push(input);
    },
  };
}
```
并修改所有 `new RunnerService(sess, graph, emitter)` 实例化为 `new RunnerService(sess, graph, emitter, llmCalls as never)`。

加 usage 用例：
```ts
  it("收到 usage 事件 → 落库 + emit run.usage", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const usageEvents: unknown[] = [];
    emitter.on(SESSION_WS_EVENTS.runUsage, (p) => usageEvents.push(p));
    const llmCalls = fakeLlmCallService();
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
    );
    await runner.kickAndWait("s1");
    expect(llmCalls.records).toHaveLength(1);
    expect((llmCalls.records[0] as { sessionId: string }).sessionId).toBe("s1");
    expect((llmCalls.records[0] as { messageId: string }).messageId).toBe(
      "msg-1",
    );
    expect((llmCalls.records[0] as { inputTokens: number }).inputTokens).toBe(
      10,
    );
    expect(usageEvents).toHaveLength(1);
    expect((usageEvents[0] as { messageId: string }).messageId).toBe("msg-1");
  });
```
（在文件顶部 import `SESSION_WS_EVENTS` 若还没。）

现有 chunk 测试（如「kick：消费 pending → 发 run.chunk/run.done → 消息转 processed」）的事件断言可能会被 usage 事件影响 —— 当前断言形如 `events.map(e=>e.name)` 等于 `["run.chunk","run.chunk","run.done"]`。fake 改后会多一个 `run.usage`。读现有断言，按需调整或过滤掉 usage：
```ts
expect(events.filter(e => e.name !== "run.usage").map(e => e.name)).toEqual([...]);
```
或直接更新为期望含 usage 的顺序。读实际测试做最小改动。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- runner.service`
Expected: FAIL（`StreamChunk` 不再是 `{messageId, delta}` 普通对象、`runOnce` 还在直接访问 `.messageId/.delta`、或 `RunnerService` 构造参数不接受 `llmCalls`）

- [ ] **Step 3: 改 RunnerService**

读 `apps/server-agent/src/services/runner.service.ts`。

**(a)** 构造加 `LlmCallService` 注入：
```ts
import { LlmCallService } from "./llm-call.service";
// ...
  constructor(
    private readonly sessions: SessionService,
    private readonly graph: GraphService,
    private readonly emitter: EventEmitter2,
    private readonly llmCalls: LlmCallService,
  ) {}
```

**(b)** `runOnce` 的 `for await (const chunk of stream)` 区分 kind：
```ts
      for await (const event of stream) {
        if (event.kind === "chunk") {
          run.messageId = event.messageId;
          run.content += event.delta;
          this.emitter.emit(SESSION_WS_EVENTS.runChunk, {
            sessionId,
            messageId: event.messageId,
            delta: event.delta,
          });
          continue;
        }
        // event.kind === "usage"
        await this.llmCalls.record({
          sessionId,
          messageId: event.messageId,
          providerType: event.providerType,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
          reasoningTokens: event.reasoningTokens,
          durationMs: event.durationMs,
        });
        this.logger.log(
          `LLM call session=${sessionId} msg=${event.messageId} provider=${event.providerType} model=${event.model} in=${event.inputTokens}(cache_read=${event.cacheReadTokens} cache_creation=${event.cacheCreationTokens}) out=${event.outputTokens}(reasoning=${event.reasoningTokens}) total=${event.totalTokens} dur=${event.durationMs}ms`,
        );
        this.emitter.emit(SESSION_WS_EVENTS.runUsage, {
          sessionId,
          messageId: event.messageId,
          providerType: event.providerType,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
          reasoningTokens: event.reasoningTokens,
          durationMs: event.durationMs,
        });
      }
```
读现有 `runOnce` 的 `for await` 块（含 chunk 处理 + 后续 `run.done` / `run.error` 等），把 chunk 处理拢在 `if (event.kind === "chunk") { ... continue; }`,然后 usage 分支。`run.done` / `markProcessed` / 错误处理保留原样在外层。

**(c)** `record` 抛错不能影响 run 完成 —— 包一层 try/catch：
```ts
        try {
          await this.llmCalls.record({ ... });
        } catch (err) {
          this.logger.error(
            `LLM 调用观测落库失败 session=${sessionId} msg=${event.messageId}`,
            err,
          );
        }
```
把这放到 record 调用周围。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- runner.service`
Expected: PASS（所有 runner 测试 + 新 usage 测试）

- [ ] **Step 5: 构建 + 围栏**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check`
Expected: 构建无错（修复了 Task 5 的预期破坏）；6 围栏 0 finding。

Also: `pnpm --filter @meshbot/agent test` —— expect agent 测试仍 PASS（确认 graph 改动没回归）。

- [ ] **Step 6: 提交**

```bash
pnpm format
git add apps/server-agent/src/services/runner.service.ts apps/server-agent/src/services/runner.service.spec.ts
git commit -m "feat(session): RunnerService 消费 usage 事件 → 落库 + 日志 + WS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7：SessionGateway 转发 run.usage + history 端点带 usage

**Files:**
- Modify: `apps/server-agent/src/ws/session.gateway.ts`
- Modify: `apps/server-agent/src/controllers/session.controller.ts`
- Test: `apps/server-agent/src/ws/session.gateway.spec.ts`

- [ ] **Step 1: SessionGateway 加 onRunUsage**

读 `apps/server-agent/src/ws/session.gateway.ts`。它有 `@OnEvent(SESSION_WS_EVENTS.runChunk)` / `runDone` / `runInterrupted` / `runError` 转发方法。加第 5 个：

import 区加 `RunUsageEvent`:
```ts
import {
  // ... 现有 import 不变
  type RunUsageEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
```

加方法（紧挨其他 `@OnEvent` 转发器）：
```ts
  /** RunnerService → run.usage → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runUsage)
  onRunUsage(payload: RunUsageEvent): void {
    this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runUsage, payload);
  }
```

- [ ] **Step 2: 加 gateway 测试**

读 `apps/server-agent/src/ws/session.gateway.spec.ts`。它有 onRunChunk/onRunDone/onRunInterrupted/onRunError 转发测试。加第 5 个：

```ts
  it("onRunUsage：把事件转发到对应房间", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    const toEmit: unknown[] = [];
    (gw as unknown as { server: unknown }).server = {
      to: () => ({ emit: (...a: unknown[]) => toEmit.push(a) }),
    };
    const payload = {
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 3,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 100,
    };
    gw.onRunUsage(payload);
    expect(toEmit[0]).toEqual([SESSION_WS_EVENTS.runUsage, payload]);
  });
```

- [ ] **Step 3: history 端点带 usage**

读 `apps/server-agent/src/controllers/session.controller.ts`。`history` 端点当前：
```ts
  @Get(":id/history")
  async history(@Param("id") id: string): Promise<HistoryResponse> {
    await this.sessions.findSessionOrFail(id);
    const messages = await this.graph.getHistory(id);
    const inflight = this.runner.getInflight(id);
    return {
      messages: messages.map(...),
      inflight,
    };
  }
```

需要注入 `LlmCallService`，调 `getSessionTotals` + `listBySession` 拼 usage。

**(a)** 加注入：
```ts
import { LlmCallService } from "../services/llm-call.service";
// ...
  constructor(
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly graph: GraphService,
    private readonly llmCalls: LlmCallService,
  ) {}
```

**(b)** `history` 方法：
```ts
  @Get(":id/history")
  async history(@Param("id") id: string): Promise<HistoryResponse> {
    await this.sessions.findSessionOrFail(id);
    const messages = await this.graph.getHistory(id);
    const inflight = this.runner.getInflight(id);
    const [sessionTotals, calls] = await Promise.all([
      this.llmCalls.getSessionTotals(id),
      this.llmCalls.listBySession(id),
    ]);
    const byMessage: Record<string, MessageUsage> = {};
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
    return {
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
      })),
      inflight,
      usage: { sessionTotals, byMessage },
    };
  }
```
（读现有 `messages.map(...)` 保留其完整映射。）

在 import 区加：
```ts
import type {
  HistoryResponse,
  MessageUsage,
  // 其他原有 import
} from "@meshbot/types-agent";
```

- [ ] **Step 4: 现有 session.e2e 仍 PASS**

读 `apps/server-agent/test/e2e/session.e2e.spec.ts`。它有 `GET /history` 的用例 —— 现在响应多了 `usage` 字段。如果用例做 `toEqual` 严格对比要更新；若只是 `expect(res.body.messages)` 等部分断言则不受影响。

读现有 history 测试，按需追加一行：
```ts
    expect(res.body.usage.sessionTotals.callCount).toBe(0);
```
（新建会话尚无 LLM 调用，totals 全 0）。

确保 e2e 模块也注册 `LlmCall` Entity + `LlmCallService`。读 e2e bootstrap module 的 `entities` 数组 + `TxTypeOrmModule.forFeature` + `providers`，把 `LlmCall` / `LlmCallService` 加进去（否则 `SessionController` 注入 `LlmCallService` 会构造失败）。

- [ ] **Step 5: 运行所有相关测试**

Run: `pnpm --filter @meshbot/server-agent test -- session.gateway`
Expected: PASS（5 用例：subscribe×2、interrupt、chunk forward、usage forward）

Run: `pnpm --filter @meshbot/server-agent test -- session.e2e`
Expected: PASS。

- [ ] **Step 6: 构建 + 围栏**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check`
Expected: 构建无错；6 围栏 0 finding。`check:repo` 应仍干净（Controller 注入 Service，Gateway 不注入 Repo）。

- [ ] **Step 7: 提交**

```bash
pnpm format
git add apps/server-agent/src/ws/session.gateway.ts apps/server-agent/src/ws/session.gateway.spec.ts apps/server-agent/src/controllers/session.controller.ts apps/server-agent/test/e2e/session.e2e.spec.ts
git commit -m "feat(session): SessionGateway 转发 run.usage + history 端点带 usage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8：前端 usage atoms

**Files:**
- Create: `apps/web-agent/src/atoms/session-usage.ts`
- Create: `apps/web-agent/src/lib/model-context-window.ts`

无单测（前端无单测惯例；构建为准）。

- [ ] **Step 1: 写 session-usage.ts**

`apps/web-agent/src/atoms/session-usage.ts`：

```ts
"use client";

import type {
  MessageUsage,
  RunUsageEvent,
  SessionTotals,
  SessionUsage,
} from "@meshbot/types-agent";
import { atom } from "jotai";

const EMPTY_TOTALS: SessionTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  callCount: 0,
};

/** messageId → 单次 LLM 调用用量。 */
export const usageByMessageAtom = atom<Record<string, MessageUsage>>({});

/** 会话累计 —— 所有 LLM 调用的 SUM + callCount。 */
export const sessionTotalsAtom = atom<SessionTotals>(EMPTY_TOTALS);

/** 用 history 接口返回的 usage 初始化 atoms。 */
export const setInitialUsageAtom = atom(null, (_get, set, u: SessionUsage) => {
  set(usageByMessageAtom, u.byMessage);
  set(sessionTotalsAtom, u.sessionTotals);
});

/** socket run.usage 增量 —— 单条 + 累加。 */
export const appendUsageAtom = atom(null, (get, set, u: RunUsageEvent) => {
  const single: MessageUsage = {
    providerType: u.providerType,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    reasoningTokens: u.reasoningTokens,
    durationMs: u.durationMs,
  };
  const byMessage = { ...get(usageByMessageAtom), [u.messageId]: single };
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
  });
});

/** 切换会话时重置（避免上轮会话累计串台）。 */
export const resetUsageAtom = atom(null, (_get, set) => {
  set(usageByMessageAtom, {});
  set(sessionTotalsAtom, EMPTY_TOTALS);
});
```

- [ ] **Step 2: 写 model-context-window.ts**

`apps/web-agent/src/lib/model-context-window.ts`：

```ts
/**
 * 常见模型的上下文窗口（token 数）。
 *
 * 用于 ChatInput 右下角 token usage 进度环的分母。本期前端 hardcode；
 * 以后做上下文压缩时再正式引入 ModelConfig.contextWindow 字段。
 *
 * 未列出的 model 名 → fallback 128_000。
 */
const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4.1": 1_000_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-haiku": 200_000,
  "deepseek-chat": 64_000,
  "deepseek-reasoner": 64_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
};

const FALLBACK = 128_000;

/** 返回 model 名对应的上下文窗口大小（未列出则返回 fallback）。 */
export function getModelContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOW[model] ?? FALLBACK;
}
```

- [ ] **Step 3: 构建确认**

Run: `pnpm --filter @meshbot/web-agent build`
Expected: 构建成功。

- [ ] **Step 4: 提交**

```bash
pnpm format
git add apps/web-agent/src/atoms/session-usage.ts apps/web-agent/src/lib/model-context-window.ts
git commit -m "feat(web-session): jotai usage atoms + 模型上下文窗口映射

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9：MessageList 显示单次用量

**Files:**
- Modify: `apps/web-agent/src/components/session/message-list.tsx`

- [ ] **Step 1: 读现状**

读 `apps/web-agent/src/components/session/message-list.tsx`。`MessageList` 当前 prop 有 `messages` 和 `onRetry?`；`TimelineMessage` 有 `id`/`role`/`content`/`failed?`/`pending?`/`streaming?` 等。气泡内根据 role 渲染对齐 + content + failed 重试按钮等。

- [ ] **Step 2: 加 usageByMessage prop + 单次用量行**

在 `MessageList` props 加：
```ts
import type { MessageUsage } from "@meshbot/types-agent";
// ...
interface MessageListProps {
  messages: TimelineMessage[];
  onRetry?: () => void;
  usageByMessage?: Record<string, MessageUsage>;
}
```

在渲染 assistant 气泡内（`role === "assistant"`），content 渲染之后加一行 muted 小字 —— 只在 `usageByMessage?.[m.id]` 存在时显示：

```tsx
{m.role === "assistant" && usageByMessage?.[m.id] && (
  <div className="mt-1 text-[11px] text-muted-foreground">
    {renderUsageLine(usageByMessage[m.id])}
  </div>
)}
```

并定义辅助 `renderUsageLine`（放在文件底部，文件内私有函数）：
```tsx
function renderUsageLine(u: MessageUsage): string {
  const parts: string[] = [`${u.providerType} · ${u.model}`];
  let inputPart = `输入 ${u.inputTokens}`;
  if (u.cacheReadTokens > 0) inputPart += `（缓存 ${u.cacheReadTokens}）`;
  parts.push(inputPart);
  let outputPart = `输出 ${u.outputTokens}`;
  if (u.reasoningTokens > 0) outputPart += `（推理 ${u.reasoningTokens}）`;
  parts.push(outputPart);
  parts.push(`${(u.durationMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}
```
读实际现有渲染结构 —— assistant 气泡的内部 markup 因为已有改动可能复杂；把 usage 行插在最适合的位置（content 之后、failed 标记之前或之后皆可，与现有 `streaming`/`failed` 的视觉层级一致）。导入 `MessageUsage` type。

- [ ] **Step 3: 构建**

Run: `pnpm --filter @meshbot/web-agent build`
Expected: 构建成功。

- [ ] **Step 4: 提交**

```bash
pnpm format
git add apps/web-agent/src/components/session/message-list.tsx
git commit -m "feat(web-session): assistant 气泡底部显示单次 LLM 调用用量

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10：ChatInput Tooltip 扩展（会话累计分项）

**Files:**
- Modify: `apps/web-agent/src/components/common/chat-input.tsx`

- [ ] **Step 1: 读现状**

读 `apps/web-agent/src/components/common/chat-input.tsx`。它有 `tokenUsage?: { current: number; max: number }` prop，右下角渲染一个 token 进度环 + Tooltip 内容是 `${current.toLocaleString()} / ${max.toLocaleString()}`。

- [ ] **Step 2: 扩展 tokenUsage 形态 + Tooltip**

把 `tokenUsage` 的类型扩展为可选地携带分项明细：

```ts
interface ChatInputProps {
  // ... 其他不变
  tokenUsage?: {
    current: number;
    max: number;
    /** 分项明细（可选）—— 提供时 Tooltip 展示详细分解。 */
    breakdown?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      reasoningTokens: number;
      callCount: number;
    };
  };
}
```

修改 `<TooltipContent>` 内容：
```tsx
<TooltipContent>
  {tokenUsage.breakdown ? (
    <div className="space-y-0.5 text-xs">
      <div>
        总计 {tokenUsage.current.toLocaleString()} /{" "}
        {tokenUsage.max.toLocaleString()}
      </div>
      <div>
        输入 {tokenUsage.breakdown.inputTokens.toLocaleString()}
        {tokenUsage.breakdown.cacheReadTokens > 0 &&
          `（缓存 ${tokenUsage.breakdown.cacheReadTokens.toLocaleString()}）`}
      </div>
      <div>
        输出 {tokenUsage.breakdown.outputTokens.toLocaleString()}
        {tokenUsage.breakdown.reasoningTokens > 0 &&
          `（推理 ${tokenUsage.breakdown.reasoningTokens.toLocaleString()}）`}
      </div>
      <div>{tokenUsage.breakdown.callCount} 次调用</div>
    </div>
  ) : (
    <>
      {tokenUsage.current.toLocaleString()} /{" "}
      {tokenUsage.max.toLocaleString()}
    </>
  )}
</TooltipContent>
```

读实际 JSX，把 `<TooltipContent>` 内的内容替换为上述条件渲染。其他渲染逻辑（外圈环、Paperclip 等）不动。

- [ ] **Step 3: 构建**

Run: `pnpm --filter @meshbot/web-agent build`
Expected: 构建成功。主页（`apps/web-agent/src/app/page.tsx`）传给 `ChatInput` 的 `tokenUsage` 是 `{ current: 12, max: 128 }`（无 breakdown）—— 与新可选字段兼容，Tooltip 走 fallback 分支。

- [ ] **Step 4: 提交**

```bash
pnpm format
git add apps/web-agent/src/components/common/chat-input.tsx
git commit -m "feat(web-session): ChatInput Tooltip 支持分项 token 明细

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11：会话页接线 usage atoms

**Files:**
- Modify: `apps/web-agent/src/app/session/page.tsx`

- [ ] **Step 1: 读现状**

读 `apps/web-agent/src/app/session/page.tsx`。当前：
- `fetchHistory` 取 messages + inflight；
- socket 监听 `run.chunk` / `run.done` / `run.interrupted` / `run.error`；
- 把 `messages` 拆为 `timelineMessages` / `queuedMessages` 渲染两区；
- `ChatInput` 当前没传 `tokenUsage`（或主页传的是 hardcode）—— 读实际代码。

要接的：
- history 返回的 `usage` → `setInitialUsage`；
- socket `run.usage` → `appendUsage`；
- `sessionId` 变化 → `resetUsage`；
- `<MessageList usageByMessage={...}/>`；
- `<ChatInput tokenUsage={{ current, max, breakdown }} />`。

- [ ] **Step 2: 改 page.tsx**

import 区加：
```ts
import {
  type RunChunkEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunInterruptedEvent,
  type RunUsageEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { useAtomValue, useSetAtom } from "jotai";
import {
  appendUsageAtom,
  resetUsageAtom,
  sessionTotalsAtom,
  setInitialUsageAtom,
  usageByMessageAtom,
} from "@/atoms/session-usage";
import { getModelContextWindow } from "@/lib/model-context-window";
import { useModelConfigs } from "@/rest/model-config";
```
（按实际 `RunChunkEvent` 等 import 现状追加 `RunUsageEvent` 和 `SESSION_WS_EVENTS`；jotai/atoms/model-context 是新加。）

组件内：
```ts
  const usageByMessage = useAtomValue(usageByMessageAtom);
  const sessionTotals = useAtomValue(sessionTotalsAtom);
  const setInitialUsage = useSetAtom(setInitialUsageAtom);
  const appendUsage = useSetAtom(appendUsageAtom);
  const resetUsage = useSetAtom(resetUsageAtom);
  const { data: modelConfigs } = useModelConfigs();
  const enabledModel = modelConfigs?.find((c) => c.enabled);
  const contextWindow = enabledModel
    ? getModelContextWindow(enabledModel.model)
    : 128_000;
```

`useEffect`（处理 sessionId）中：
- 在初始 `void Promise.all([fetchHistory, fetchPending]).then(...)` 的 `.then(([history, pending]) => { ... })` 内，调 `setInitialUsage(history.usage)` —— 在合适位置（处理完 history.messages 后立即调即可）。
- 在 socket handlers 块加 `onUsage` 处理器：
```ts
    const onUsage = (e: RunUsageEvent) => {
      if (e.sessionId !== sessionId) return;
      appendUsage(e);
    };
    socket.on(SESSION_WS_EVENTS.runUsage, onUsage);
```
- cleanup 加 `socket.off(SESSION_WS_EVENTS.runUsage, onUsage);`。
- effect 起首加 `resetUsage()` —— sessionId 变化时清空上轮累计：
```ts
    if (!sessionId) {
      // ... 原逻辑
      return;
    }
    resetUsage();
    // ... 其他原逻辑
```
读实际 useEffect 结构精确添加 —— 它已经有不少分支（cancel flag、router.replace 等）；新增不要打乱已有。

deps 数组按需加 `setInitialUsage` / `appendUsage` / `resetUsage` —— 它们由 `useSetAtom` 返回稳定函数引用，安全。

JSX 改：
```tsx
        <MessageList
          messages={timelineMessages}
          onRetry={handleRetry}
          usageByMessage={usageByMessage}
        />
```
```tsx
        <ChatInput
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          isLoading={running}
          tokenUsage={{
            current: sessionTotals.totalTokens,
            max: contextWindow,
            breakdown: {
              inputTokens: sessionTotals.inputTokens,
              outputTokens: sessionTotals.outputTokens,
              cacheReadTokens: sessionTotals.cacheReadTokens,
              reasoningTokens: sessionTotals.reasoningTokens,
              callCount: sessionTotals.callCount,
            },
          }}
        />
```

读现有 `<MessageList>` 和 `<ChatInput>` 渲染处，把这两段精确加进去（保留其他 prop 不变）。

- [ ] **Step 3: 构建**

Run: `pnpm --filter @meshbot/web-agent build`
Expected: 构建成功。

- [ ] **Step 4: 提交**

```bash
pnpm format
git add apps/web-agent/src/app/session/page.tsx
git commit -m "feat(web-session): 会话页接入 usage atoms（history 初始化 + WS 增量 + 显示）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12：全量回归 + 手动冒烟

**Files:** 无（验证 Task）

- [ ] **Step 1: 全量回归**

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @meshbot/agent test
pnpm check
```
Expected: 全绿。读完整输出（避免 turbo 退出码/tail 掩盖矛盾态 `Test Suites: M failed`）。

- [ ] **Step 2: 端到端冒烟**

需 deepseek 真实 key 配置。两个终端：
```
pnpm dev:server-agent
pnpm dev:web-agent
```

验证三条：
1. **控制台日志** — 发一条消息,server-agent 日志出现一行 `LLM call session=... msg=... provider=deepseek model=... in=N(cache_read=K cache_creation=W) out=M(reasoning=R) total=T dur=Xms`。token 数 > 0。
2. **每条回复底部 token 行** — assistant 气泡底部出现 muted 小字 `deepseek · deepseek-chat · 输入 N(缓存 K) / 输出 M · X.Xs`,缓存命中(若有)显示。
3. **ChatInput 累计** — 右下角进度环 token 用量随回复增长;Tooltip 悬停显示分项明细 `总计 / 输入 / 输出 / N 次调用`。
4. **刷新页面累计仍在** — 刷新后右下角累计 token 与刷新前一致(`GET /history` 携带 usage 返回所致)。

报告四条冒烟结果。任一不符报 BLOCKED + 现象。

- [ ] **Step 3: 提交（若冒烟暴露需修的小问题）**

冒烟全过则本 Task 无提交。

---

## 完成标准

- 每次 LLM 调用控制台一行结构化日志(provider/model/in/out/cache/reasoning/total/dur)
- `llm_calls` 表每次成功调用一行
- WS `run.usage` 事件推前端
- 前端每条 assistant 回复底部显示单次 token 明细
- 前端 `ChatInput` 右下角显示**会话累计** token,Tooltip 显示分项
- 刷新页面后会话累计仍能显示(`GET /history` 返回 `usage` 字段)
- `pnpm typecheck` / `build` / `test` / `pnpm --filter @meshbot/agent test` / `pnpm check` 全绿
