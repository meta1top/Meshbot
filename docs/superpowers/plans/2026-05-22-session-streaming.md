# 会话创建 + Agent 流式 run 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通「首页输入文字 → 创建会话 → 异步发起 Agent 流式 run → token 级 socket.io 推送 → 前端订阅实时显示」的完整链路。

**Architecture:** server-agent 进程内 `RunnerService` 维护内存 inflight + 消费循环，驱动 `libs/agent` 的流式 `GraphService.streamMessage`。`PendingMessage` 表只管未处理用户消息排队；assistant 回复由 LangGraph SQLite checkpointer 持有。Runner 经 `EventEmitter2` 把 token chunk 发给 `SessionGateway`，由 socket.io 推到以 `sessionId` 为 room 的前端。流式 assistant 消息用 LangGraph `AIMessage.id` 作分组键。

**Tech Stack:** NestJS 11、TypeORM (better-sqlite3)、LangGraph + LangChain `initChatModel`、socket.io、`@nestjs/event-emitter`、Next.js 15（静态导出）、socket.io-client、Zod。

---

## 背景与约定（实施前必读）

- **仓库**：meshbot monorepo（pnpm + Turbo）。本特性只动本地轨：`apps/server-agent`、`apps/web-agent`、`libs/agent`、`libs/types-agent`。
- **依赖方向**：`apps/server-agent` → `libs/agent` → `libs/types-agent`。禁止反向。
- **Entity 归属**（`pnpm check:repo` 强制）：每个 Entity 唯一归属一个 Service。`Session` / `PendingMessage` 归属 `SessionService`。Controller / Gateway 禁止注入 Repository。
- **事务**（`pnpm check:tx` / `check:naming` 强制）：跨表写入用 `@Transactional()`（从 `@meshbot/common` 导入）；单表写入不用。私有 `@Transactional()` 方法名必须以 `*InDb` / `*InTx` / `persist*` 命中约定。模块用 `TxTypeOrmModule.forFeature()` 注册 Entity。
- **数据库**：本地轨 SQLite，`synchronize: false` + 迁移文件。主键 UUID。列名 snake_case。SQLite 无 varchar，统一 TEXT。
- **测试**：server-agent / libs/types-agent 用 Jest；`libs/agent` 历史用 vitest，沿用。
- **静态围栏**：每个 Task 末尾 commit 前若改了 `*.service.ts` / `*.entity.ts` / `*.controller.ts` / `*.gateway.ts`，跑 `pnpm check`。
- **提交信息**：中文，conventional commits 风格，结尾加 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。
- **公开方法**：写中文 JSDoc。
- **格式**：commit 前 `pnpm format`（Biome）。禁止在 `if` 前一行放注释。

## 文件结构总览

**新建：**
| 文件 | 职责 |
|---|---|
| `libs/types-agent/src/session.ts` | Session / PendingMessage / socket 事件 / REST DTO 的 Zod schema（前后端共用） |
| `libs/agent/src/config/model-config.reader.ts` | 只读 `model_configs` 表，返回启用的模型凭证 |
| `libs/agent/src/graph/llm.factory.ts` | 用 `initChatModel` 按凭证构造流式 LLM |
| `apps/server-agent/src/entities/session.entity.ts` | `Session` Entity |
| `apps/server-agent/src/entities/pending-message.entity.ts` | `PendingMessage` Entity |
| `apps/server-agent/src/migrations/<ts>-SessionTables.ts` | 两表 DDL 迁移 |
| `apps/server-agent/src/services/session.service.ts` | Session/PendingMessage 归属 Service + 业务 |
| `apps/server-agent/src/services/runner.service.ts` | 进程内 run 消费循环 + 内存 inflight |
| `apps/server-agent/src/controllers/session.controller.ts` | 4 个 REST 端点（瘦） |
| `apps/server-agent/src/dto/session.dto.ts` | createZodDto 派生的 NestJS DTO |
| `apps/server-agent/src/session.module.ts` | 聚合上述 server-agent 侧 provider |
| `apps/server-agent/src/ws/session.gateway.ts` | socket.io Gateway |
| `apps/web-agent/src/rest/session.ts` | 4 个接口 axios 封装 |
| `apps/web-agent/src/lib/socket.ts` | socket.io-client 单例 |
| `apps/web-agent/src/app/session/page.tsx` | 会话页（静态页 + query 参数） |
| `apps/web-agent/src/components/session/message-list.tsx` | 消息时间线渲染 |

**修改：**
| 文件 | 改动 |
|---|---|
| `libs/agent/src/graph/graph.service.ts` | 新增 `streamMessage` 异步迭代器 |
| `libs/agent/src/graph/graph.builder.ts` / `nodes/supervisor.node.ts` | supervisor 节点接真实流式 LLM |
| `libs/agent/src/agent.module.ts` | 导出新 provider |
| `libs/agent/src/index.ts` | 导出 `streamMessage` 相关类型 |
| `apps/server-agent/src/app.module.ts` | 引入 `EventEmitterModule` + `SessionModule` |
| `apps/server-agent/package.json` | 新增 socket.io / event-emitter 依赖 |
| `libs/agent/package.json` | 新增 `langchain` 依赖 |
| `apps/web-agent/package.json` | 新增 `socket.io-client` |
| `apps/web-agent/src/app/page.tsx` | `ChatInput.onSend` 接真实逻辑 |
| `apps/web-agent/src/rest/index.ts` | 导出 session hooks |

---

## Task 1：共享 Zod schema（libs/types-agent）

**Files:**
- Create: `libs/types-agent/src/session.ts`
- Modify: `libs/types-agent/src/index.ts`
- Test: `libs/types-agent/src/session.spec.ts`

- [ ] **Step 1: 写失败测试**

`libs/types-agent/src/session.spec.ts`：

```ts
import { describe, expect, it } from "@jest/globals";
import {
  CreateSessionSchema,
  RunChunkEventSchema,
  SessionStatus,
} from "./session";

describe("session schemas", () => {
  it("CreateSessionSchema 接受非空 content", () => {
    expect(CreateSessionSchema.parse({ content: "hello" })).toEqual({
      content: "hello",
    });
  });

  it("CreateSessionSchema 拒绝空 content", () => {
    expect(() => CreateSessionSchema.parse({ content: "" })).toThrow();
  });

  it("SessionStatus 枚举包含 idle / running", () => {
    expect(SessionStatus.options).toEqual(["idle", "running"]);
  });

  it("RunChunkEventSchema 校验流式 chunk 载荷", () => {
    const payload = { sessionId: "s1", messageId: "m1", delta: "tok" };
    expect(RunChunkEventSchema.parse(payload)).toEqual(payload);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/types-agent test -- session.spec`
Expected: FAIL — `Cannot find module './session'`

- [ ] **Step 3: 写实现**

`libs/types-agent/src/session.ts`：

```ts
import { z } from "zod";

/** 会话状态：idle = 无 run；running = 有 run 在跑。 */
export const SessionStatus = z.enum(["idle", "running"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** 待处理用户消息状态。 */
export const PendingMessageStatus = z.enum([
  "pending",
  "processing",
  "processed",
]);
export type PendingMessageStatus = z.infer<typeof PendingMessageStatus>;

/** POST /api/sessions 入参。 */
export const CreateSessionSchema = z.object({
  content: z.string().min(1),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

/** POST /api/sessions/:id/messages 入参。 */
export const AppendMessageSchema = z.object({
  content: z.string().min(1),
});
export type AppendMessageInput = z.infer<typeof AppendMessageSchema>;

/** 会话历史中的一条消息（来自 LangGraph checkpointer）。 */
export const HistoryMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/** 当前未完成 assistant 消息快照。 */
export const InflightSnapshotSchema = z.object({
  messageId: z.string().nullable(),
  content: z.string(),
  status: z.enum(["streaming", "done", "interrupted"]),
});
export type InflightSnapshot = z.infer<typeof InflightSnapshotSchema>;

/** 排队中的用户消息。 */
export const PendingMessageDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  content: z.string(),
  status: PendingMessageStatus,
  createdAt: z.string(),
});
export type PendingMessageDto = z.infer<typeof PendingMessageDtoSchema>;

/** GET /api/sessions/:id/history 出参。 */
export const HistoryResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
  inflight: InflightSnapshotSchema.nullable(),
});
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

/** GET /api/sessions/:id/pending 出参。 */
export const PendingResponseSchema = z.object({
  pending: z.array(PendingMessageDtoSchema),
});
export type PendingResponse = z.infer<typeof PendingResponseSchema>;

/** socket: run.chunk 事件载荷。 */
export const RunChunkEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  delta: z.string(),
});
export type RunChunkEvent = z.infer<typeof RunChunkEventSchema>;

/** socket: run.done 事件载荷。 */
export const RunDoneEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  content: z.string(),
});
export type RunDoneEvent = z.infer<typeof RunDoneEventSchema>;

/** socket: run.interrupted 事件载荷。 */
export const RunInterruptedEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});
export type RunInterruptedEvent = z.infer<typeof RunInterruptedEventSchema>;

/** socket: run.error 事件载荷。 */
export const RunErrorEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string().nullable(),
  error: z.string(),
});
export type RunErrorEvent = z.infer<typeof RunErrorEventSchema>;

/** socket: 客户端 session.subscribe / session.interrupt 入参。 */
export const SessionTopicSchema = z.object({ sessionId: z.string() });
export type SessionTopic = z.infer<typeof SessionTopicSchema>;

/** WS namespace 与事件名常量。 */
export const SESSION_WS_NAMESPACE = "ws/session";
export const SESSION_WS_EVENTS = {
  subscribe: "session.subscribe",
  interrupt: "session.interrupt",
  runChunk: "run.chunk",
  runDone: "run.done",
  runInterrupted: "run.interrupted",
  runError: "run.error",
} as const;
```

`libs/types-agent/src/index.ts` 末尾追加：

```ts
export * from "./session";
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/types-agent test -- session.spec`
Expected: PASS（4 个用例）

- [ ] **Step 5: 构建 types-agent（下游依赖它的 dist）**

Run: `pnpm --filter @meshbot/types-agent build`
Expected: 无报错

- [ ] **Step 6: 提交**

```bash
pnpm format
git add libs/types-agent/src/session.ts libs/types-agent/src/session.spec.ts libs/types-agent/src/index.ts
git commit -m "feat(session): types-agent 新增会话流式共享 schema

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2：Session / PendingMessage Entity + 迁移

**Files:**
- Create: `apps/server-agent/src/entities/session.entity.ts`
- Create: `apps/server-agent/src/entities/pending-message.entity.ts`
- Create: `apps/server-agent/src/migrations/1779100000000-SessionTables.ts`

无单测（纯声明式 Entity / DDL），由后续 Task 的 Service 测试间接覆盖。

- [ ] **Step 1: 写 `Session` Entity**

`apps/server-agent/src/entities/session.entity.ts`：

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** 会话表。id 同时作为 LangGraph thread_id 与 socket.io room id。 */
@Entity("sessions")
export class Session {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  title!: string;

  /** idle = 无 run 在跑；running = 有 run 在跑。 */
  @Column({ default: "idle" })
  status!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

- [ ] **Step 2: 写 `PendingMessage` Entity**

`apps/server-agent/src/entities/pending-message.entity.ts`：

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

/** 待处理用户消息表。按 session 排队，run 结束后整批取出处理。 */
@Entity("pending_messages")
export class PendingMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** 逻辑外键，无 DB 约束。 */
  @Column({ name: "session_id" })
  sessionId!: string;

  @Column({ type: "text" })
  content!: string;

  /** pending = 排队中；processing = 已取出处理中；processed = 已完成。 */
  @Column({ default: "pending" })
  status!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @Column({ name: "processed_at", type: "datetime", nullable: true })
  processedAt!: Date | null;
}
```

- [ ] **Step 3: 写迁移文件**

`apps/server-agent/src/migrations/1779100000000-SessionTables.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 会话相关两张表：sessions / pending_messages。
 *
 * - IF NOT EXISTS 保证幂等
 * - SQLite 统一 TEXT；UUID 也是 TEXT
 * - pending_messages.session_id 逻辑外键，无 DB 约束
 * - 按 session_id + status 建索引，加速 RunnerService 取 pending 消息
 */
export class SessionTables1779100000000 implements MigrationInterface {
  name = "SessionTables1779100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sessions" (
        "id"         TEXT PRIMARY KEY NOT NULL,
        "title"      TEXT NOT NULL,
        "status"     TEXT NOT NULL DEFAULT 'idle',
        "created_at" DATETIME NOT NULL DEFAULT (datetime('now')),
        "updated_at" DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pending_messages" (
        "id"           TEXT PRIMARY KEY NOT NULL,
        "session_id"   TEXT NOT NULL,
        "content"      TEXT NOT NULL,
        "status"       TEXT NOT NULL DEFAULT 'pending',
        "created_at"   DATETIME NOT NULL DEFAULT (datetime('now')),
        "processed_at" DATETIME
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_pending_messages_session_status" ON "pending_messages" ("session_id", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_pending_messages_session_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "pending_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sessions"`);
  }
}
```

- [ ] **Step 4: 把两个 Entity 注册进 TypeORM**

修改 `apps/server-agent/src/app.module.ts`：

在 import 区加：
```ts
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
```

`TypeOrmModule.forRoot({ ... })` 的 `entities` 数组从 `[ModelConfig, Setting, User]` 改为：
```ts
entities: [ModelConfig, Setting, User, Session, PendingMessage],
```

> 注意：本 Task 只把 Entity 加进 `forRoot` 的 `entities`（让 TypeORM 认识它们）。`TxTypeOrmModule.forFeature` 的注册在 Task 6 的 `SessionModule` 里做，不在这里。

- [ ] **Step 5: 验证迁移能跑通**

Run: `pnpm --filter @meshbot/server-agent build`
Expected: TS 编译无报错

启动一次 server-agent 让迁移执行（`migrationsRun: true`）：
Run: `pnpm dev:server-agent`（启动后看到日志含 `SessionTables1779100000000` 已执行，然后 Ctrl-C）
Expected: 日志显示迁移成功；`~/.meshbot/agent.db` 或仓库 `.meshbot/agent.db` 出现 `sessions` / `pending_messages` 表

- [ ] **Step 6: 提交**

```bash
pnpm format
git add apps/server-agent/src/entities/session.entity.ts apps/server-agent/src/entities/pending-message.entity.ts apps/server-agent/src/migrations/1779100000000-SessionTables.ts apps/server-agent/src/app.module.ts
git commit -m "feat(session): 新增 Session / PendingMessage 表与迁移

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3：libs/agent — 读 ModelConfig + LLM 工厂

`libs/agent` 当前完全没接 LLM。agent 进程已直连 `agent.db`（checkpointer 用），故让它只读 `model_configs` 表拿凭证，不引入 TypeORM Entity，把耦合面控制在「一张表的列名」。

**Files:**
- Create: `libs/agent/src/config/model-config.reader.ts`
- Create: `libs/agent/src/graph/llm.factory.ts`
- Modify: `libs/agent/package.json`（加 `langchain` 依赖）
- Test: `libs/agent/tests/unit/model-config.reader.test.ts`

- [ ] **Step 1: 装依赖**

`langchain` 提供 `initChatModel`（多供应商动态加载）。

Run: `pnpm --filter @meshbot/agent add langchain`
Expected: `libs/agent/package.json` dependencies 出现 `langchain`

- [ ] **Step 2: 写 reader 失败测试**

`libs/agent/tests/unit/model-config.reader.test.ts`：

```ts
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readActiveModelConfig } from "../../src/config/model-config.reader";

describe("readActiveModelConfig", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meshbot-mc-"));
    dbPath = path.join(dir, "agent.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE model_configs (
      id TEXT PRIMARY KEY, provider_type TEXT, name TEXT, model TEXT,
      api_key TEXT, base_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      created_at DATETIME, updated_at DATETIME)`);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("无启用配置时返回 null", () => {
    expect(readActiveModelConfig(dbPath)).toBeNull();
  });

  it("返回首个启用的配置", () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO model_configs (id, provider_type, name, model, api_key, base_url, enabled)
       VALUES (?,?,?,?,?,?,?)`,
    ).run("1", "openai", "默认", "gpt-4o", "sk-test", "https://x", 1);
    db.close();
    expect(readActiveModelConfig(dbPath)).toEqual({
      providerType: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      baseUrl: "https://x",
    });
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/agent test -- model-config.reader`
Expected: FAIL — `Cannot find module '../../src/config/model-config.reader'`

- [ ] **Step 4: 写 reader 实现**

`libs/agent/src/config/model-config.reader.ts`：

```ts
import Database from "better-sqlite3";

/** 启用的模型凭证。来自 server-agent 的 model_configs 表。 */
export interface ActiveModelConfig {
  providerType: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * 只读 agent.db 的 model_configs 表，返回首个 enabled 的模型凭证。
 *
 * agent 进程本就持有 agent.db 路径（checkpointer 用）；这里复用同一文件做
 * 单表只读 SELECT，不引入 TypeORM Entity，把对 server-agent 表 schema 的
 * 耦合面控制在「列名」这一层。无启用配置返回 null。
 */
export function readActiveModelConfig(
  dbPath: string,
): ActiveModelConfig | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT provider_type, model, api_key, base_url
         FROM model_configs WHERE enabled = 1
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as
      | {
          provider_type: string;
          model: string;
          api_key: string;
          base_url: string;
        }
      | undefined;
    if (!row) return null;
    return {
      providerType: row.provider_type,
      model: row.model,
      apiKey: row.api_key,
      baseUrl: row.base_url,
    };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/agent test -- model-config.reader`
Expected: PASS（2 个用例）

- [ ] **Step 6: 写 LLM 工厂**

`libs/agent/src/graph/llm.factory.ts`（无独立单测 —— 它只是对 `initChatModel` 的薄封装，由 Task 5 的流式集成测试间接覆盖）：

```ts
import { initChatModel } from "langchain/chat_models/universal";
import type { ActiveModelConfig } from "../config/model-config.reader";

/**
 * 按模型凭证构造一个支持流式的 LangChain chat model。
 *
 * 用 `initChatModel` 动态加载对应供应商的集成包，按 `providerType` 路由。
 * `streaming: true` 让 `.stream()` 走 token 级增量输出。
 */
export async function createChatModel(config: ActiveModelConfig) {
  return initChatModel(config.model, {
    modelProvider: config.providerType,
    apiKey: config.apiKey,
    ...(config.baseUrl ? { configuration: { baseURL: config.baseUrl } } : {}),
    streaming: true,
  });
}
```

> 说明：`initChatModel` 按 `modelProvider` 懒加载集成包（如 `@langchain/openai`）。实施时若运行报「缺少 peer 包」，按报错提示 `pnpm --filter @meshbot/agent add <提示的包>`，并在本 Task 的 commit 里一并带上。

- [ ] **Step 7: 构建确认**

Run: `pnpm --filter @meshbot/agent build`
Expected: TS 编译无报错

- [ ] **Step 8: 提交**

```bash
pnpm format
git add libs/agent/src/config/model-config.reader.ts libs/agent/src/graph/llm.factory.ts libs/agent/tests/unit/model-config.reader.test.ts libs/agent/package.json pnpm-lock.yaml
git commit -m "feat(agent): 新增 model_configs 只读 reader 与 LLM 工厂

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4：supervisor 节点接真实流式 LLM

让 supervisor 节点调用真实 LLM。当前它是 `return { messages: state.messages }` 占位。

**Files:**
- Modify: `libs/agent/src/graph/nodes/supervisor.node.ts`
- Modify: `libs/agent/src/graph/graph.builder.ts`
- Test: `libs/agent/tests/unit/supervisor.node.test.ts`

- [ ] **Step 1: 写失败测试**

`libs/agent/tests/unit/supervisor.node.test.ts`：

```ts
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { createSupervisorNode } from "../../src/graph/nodes/supervisor.node";

describe("createSupervisorNode", () => {
  it("调用注入的 model 并把 AIMessage 追加到 state", async () => {
    const fakeModel = {
      invoke: vi.fn().mockResolvedValue(new AIMessage("你好")),
    };
    const node = createSupervisorNode(() => Promise.resolve(fakeModel as never));
    const result = await node({ messages: [new HumanMessage("hi")] });
    expect(fakeModel.invoke).toHaveBeenCalledTimes(1);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as AIMessage).content).toBe("你好");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/agent test -- supervisor.node`
Expected: FAIL — `createSupervisorNode is not exported`

- [ ] **Step 3: 改写 supervisor 节点**

`libs/agent/src/graph/nodes/supervisor.node.ts` 整体替换为：

```ts
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";

export interface SupervisorState {
  messages: BaseMessage[];
}

/** 惰性提供 chat model 的工厂（每次 run 取最新凭证）。 */
export type ModelProvider = () => Promise<BaseChatModel>;

/**
 * 创建 supervisor 节点：把当前消息历史交给 LLM，产出一条 AIMessage。
 *
 * model 经工厂惰性获取，便于按 run 取最新 ModelConfig，也便于测试注入 fake。
 * 节点只返回新增的 AIMessage —— graph 的 reducer 负责 concat 进 state。
 */
export function createSupervisorNode(modelProvider: ModelProvider) {
  return async function supervisorNode(
    state: SupervisorState,
  ): Promise<Partial<SupervisorState>> {
    const model = await modelProvider();
    const reply = await model.invoke(state.messages);
    return { messages: [reply] };
  };
}
```

> 注意：旧的 `supervisorNode` 具名导出被移除。它当前仅被 `graph.builder.ts` 引用（下一步会改 builder），无其他引用 —— `pnpm check:dead` 不会因此报错。

- [ ] **Step 4: 改 graph.builder 接受 modelProvider**

`libs/agent/src/graph/graph.builder.ts` 整体替换为：

```ts
import type { BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createSupervisorNode, type ModelProvider } from "./nodes/supervisor.node";

export interface GraphState {
  messages: BaseMessage[];
}

/** 构建 supervisor 单节点图。modelProvider 惰性提供 LLM。 */
export function buildSupervisorGraph(
  checkpointer: SqliteSaver,
  modelProvider: ModelProvider,
) {
  return new StateGraph<GraphState>({
    channels: {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
      },
    },
  })
    .addNode("supervisor", createSupervisorNode(modelProvider))
    .addEdge(START, "supervisor")
    .addEdge("supervisor", END)
    .compile({ checkpointer });
}
```

- [ ] **Step 5: 运行 supervisor 测试，确认通过**

Run: `pnpm --filter @meshbot/agent test -- supervisor.node`
Expected: PASS（1 个用例）

- [ ] **Step 6: 提交**

```bash
pnpm format
git add libs/agent/src/graph/nodes/supervisor.node.ts libs/agent/src/graph/graph.builder.ts libs/agent/tests/unit/supervisor.node.test.ts
git commit -m "feat(agent): supervisor 节点接入真实 LLM（modelProvider 注入）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5：GraphService.streamMessage 流式接口

给 `GraphService` 加流式方法。当前它只有同步 `sendMessage`，且 `buildSupervisorGraph` 调用签名已在 Task 4 改变 —— 本 Task 一并修好。

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts`
- Modify: `libs/agent/src/index.ts`
- Test: `libs/agent/tests/unit/graph.service.test.ts`

- [ ] **Step 1: 先修 graph.service 编译（Task 4 改了 builder 签名）**

`libs/agent/src/graph/graph.service.ts` 的 constructor 当前是：
```ts
this.graph = buildSupervisorGraph(this.checkpointer);
```
本 Task Step 3 会整体重写该文件，此处先了解：`buildSupervisorGraph` 现在需要第二个参数 `modelProvider`。

- [ ] **Step 2: 写 streamMessage 失败测试**

在 `libs/agent/tests/unit/graph.service.test.ts` 末尾（`describe` 内）追加：

```ts
  it("streamMessage 逐 chunk 产出 token 与稳定 messageId", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    const chunks: { messageId: string; delta: string }[] = [];
    for await (const ev of graphService.streamMessage(threadId, "hi")) {
      chunks.push(ev);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.messageId === chunks[0].messageId)).toBe(true);
  });
```

测试需要一个不依赖真实网络的 model。在该测试文件 `beforeEach` 里，把 `GraphService` 改为用注入的 fake model provider 构造 —— 见 Step 3 的 GraphService 新签名：第三参数 `modelProvider` 可选，测试传一个产出固定 `AIMessageChunk` 流的 fake。

在测试文件顶部 import 区加：
```ts
import { AIMessageChunk } from "@langchain/core/messages";
```

在 `beforeEach` 中构造 GraphService 处改为：
```ts
const fakeModel = {
  // langgraph streamMode:"messages" 要求 model 支持 .stream()
  stream: async function* () {
    yield new AIMessageChunk({ id: "fixed-msg-id", content: "你" });
    yield new AIMessageChunk({ id: "fixed-msg-id", content: "好" });
  },
  invoke: async () => new AIMessageChunk({ id: "fixed-msg-id", content: "你好" }),
};
graphService = new GraphService(configService, promptService, () =>
  Promise.resolve(fakeModel as never),
);
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/agent test -- graph.service`
Expected: FAIL — `graphService.streamMessage is not a function`（以及 constructor 第三参数类型错误）

- [ ] **Step 4: 重写 GraphService**

`libs/agent/src/graph/graph.service.ts` 整体替换为：

```ts
import { randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessageChunk, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Injectable } from "@nestjs/common";
import { createSqliteCheckpointer } from "../checkpoint/sqlite-checkpointer";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { readActiveModelConfig } from "../config/model-config.reader";
import { createChatModel } from "./llm.factory";
import type { ModelProvider } from "./nodes/supervisor.node";
import { PromptService } from "../prompt/prompt.service";
import type { GraphState } from "./graph.builder";
import { buildSupervisorGraph } from "./graph.builder";

export interface AgentConfig {
  model: string;
  temperature?: number;
  systemPrompt?: string;
  tools?: string[];
}

export type ThreadId = string;

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

/** 流式 run 产出的单个 token 事件。 */
export interface StreamChunk {
  messageId: string;
  delta: string;
}

@Injectable()
export class GraphService {
  private checkpointer: ReturnType<typeof createSqliteCheckpointer>;
  private graph: ReturnType<typeof buildSupervisorGraph>;

  constructor(
    private configService: MeshbotConfigService,
    private promptService: PromptService,
    modelProvider?: ModelProvider,
  ) {
    const dbPath = this.configService.getDatabasePath();
    this.checkpointer = createSqliteCheckpointer(dbPath);
    const provider: ModelProvider =
      modelProvider ?? (() => this.resolveModel());
    this.graph = buildSupervisorGraph(this.checkpointer, provider);
  }

  /** 按当前 agent.db 的启用 ModelConfig 构造 chat model。 */
  private async resolveModel(): Promise<BaseChatModel> {
    const cfg = readActiveModelConfig(this.configService.getDatabasePath());
    if (!cfg) {
      throw new Error("没有启用的模型配置（model_configs 表为空或全部 disabled）");
    }
    return (await createChatModel(cfg)) as BaseChatModel;
  }

  /** 创建会话：写入 system prompt（若有），返回 thread id。 */
  async startSession(config: AgentConfig): Promise<ThreadId> {
    const threadId = randomUUID();
    const systemPrompt =
      config.systemPrompt ?? this.promptService.getPrompt("system");
    if (systemPrompt) {
      await this.checkpointer.put(
        { configurable: { thread_id: threadId } } as never,
        { v: 1, messages: [] } as never,
        {} as never,
        {} as never,
      );
    }
    return threadId;
  }

  /**
   * 向会话发送一条消息并逐 token 流式产出 assistant 回复。
   *
   * 基于 LangGraph `graph.stream(..., { streamMode: "messages" })`：
   * 每个 chunk 带稳定 `message.id`，作为本条 assistant 消息的标识。
   * 透传 `signal` 支持中断。
   */
  async *streamMessage(
    threadId: ThreadId,
    message: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    this.promptService.reloadIfChanged();
    const stream = await this.graph.stream(
      { messages: [new HumanMessage(message)] },
      {
        configurable: { thread_id: threadId },
        streamMode: "messages",
        signal,
      },
    );
    for await (const part of stream) {
      const msg = Array.isArray(part) ? part[0] : part;
      if (!(msg instanceof AIMessageChunk)) continue;
      const delta = typeof msg.content === "string" ? msg.content : "";
      if (!delta) continue;
      yield { messageId: msg.id ?? threadId, delta };
    }
  }

  /** 取会话已处理消息历史（来自 checkpointer）。 */
  async getHistory(threadId: ThreadId): Promise<Message[]> {
    const snapshot = await this.graph.getState({
      configurable: { thread_id: threadId },
    });
    const values = snapshot.values as GraphState;
    if (!values?.messages) return [];
    return values.messages.map((m: BaseMessage) => ({
      id: m.id ?? randomUUID(),
      role: this.roleOf(m),
      content: typeof m.content === "string" ? m.content : "",
    }));
  }

  private roleOf(m: BaseMessage): "user" | "assistant" | "system" {
    const t = m._getType();
    if (t === "human") return "user";
    if (t === "system") return "system";
    return "assistant";
  }
}
```

> 注意：旧 `startSession` 用 `graph.invoke` 写 system message；为避免占用一次 LLM 调用，改为直接用 checkpointer 落初始 state。若该 `checkpointer.put` 签名在实施时与 `@langchain/langgraph-checkpoint-sqlite@0.1` 不符，退化方案：`startSession` 仅返回 `randomUUID()`，system prompt 在 `streamMessage` 首次调用时作为 `SystemMessage` 一并传入。实施时以编译/测试通过为准，二选一。

- [ ] **Step 5: 同步更新 graph.service.test.ts 中受影响的旧用例**

旧测试里 `sendMessage` / `response.content` 相关用例已不适用（`sendMessage` 被移除）。把那两个旧用例（`"sends message and returns response"`、`"returns history after messages"` 中依赖 `sendMessage` 的部分）删除或改为调用 `streamMessage`。`startSession` 用例保留。

- [ ] **Step 6: 运行全部 graph.service 测试，确认通过**

Run: `pnpm --filter @meshbot/agent test -- graph.service`
Expected: PASS

- [ ] **Step 7: 导出新类型**

`libs/agent/src/index.ts` 确认导出 `GraphService`、`StreamChunk`、`Message`、`ThreadId`、`AgentConfig`。若缺则补：

```ts
export {
  GraphService,
  type AgentConfig,
  type Message,
  type StreamChunk,
  type ThreadId,
} from "./graph/graph.service";
```

- [ ] **Step 8: 构建 + 全量 agent 测试**

Run: `pnpm --filter @meshbot/agent build && pnpm --filter @meshbot/agent test`
Expected: 全部 PASS

- [ ] **Step 9: 提交**

```bash
pnpm format
git add libs/agent/src/graph/graph.service.ts libs/agent/src/index.ts libs/agent/tests/unit/graph.service.test.ts
git commit -m "feat(agent): GraphService 新增 streamMessage 流式接口

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6：SessionService + DTO + SessionModule 骨架

`SessionService` 是 `Session` / `PendingMessage` 的唯一归属 Service。本 Task 先做不依赖 RunnerService 的纯数据方法（创建会话、追加消息、查询）。`RunnerService` 在 Task 7 建好后，Task 8 再把 `kick` 调用接进来。

**Files:**
- Create: `apps/server-agent/src/dto/session.dto.ts`
- Create: `apps/server-agent/src/services/session.service.ts`
- Create: `apps/server-agent/src/session.module.ts`
- Modify: `apps/server-agent/src/app.module.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`

- [ ] **Step 1: 写 DTO**

`apps/server-agent/src/dto/session.dto.ts`：

```ts
import { createZodDto } from "@meshbot/common";
import { AppendMessageSchema, CreateSessionSchema } from "@meshbot/types-agent";

/** POST /api/sessions 入参 DTO。 */
export class CreateSessionDto extends createZodDto(CreateSessionSchema) {}

/** POST /api/sessions/:id/messages 入参 DTO。 */
export class AppendMessageDto extends createZodDto(AppendMessageSchema) {}
```

- [ ] **Step 2: 写 SessionService 失败测试**

`apps/server-agent/src/services/session.service.spec.ts`（用内存 sqlite + TypeORM DataSource，参照 monorepo 已有 service 测试风格）：

```ts
import { DataSource } from "typeorm";
import { PendingMessage } from "../entities/pending-message.entity";
import { Session } from "../entities/session.entity";
import { SessionService } from "./session.service";

describe("SessionService", () => {
  let ds: DataSource;
  let service: SessionService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Session, PendingMessage],
      synchronize: true,
    });
    await ds.initialize();
    service = new SessionService(
      ds.getRepository(Session),
      ds.getRepository(PendingMessage),
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("createSession 建会话(running) + 写首条 pending 消息", async () => {
    const { sessionId } = await service.createSession({ content: "你好世界" });
    const session = await service.findSessionOrFail(sessionId);
    expect(session.status).toBe("running");
    const pending = await service.listActivePending(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("你好世界");
    expect(pending[0].status).toBe("pending");
  });

  it("createSession 用 content 前 30 字作 title", async () => {
    const long = "a".repeat(50);
    const { sessionId } = await service.createSession({ content: long });
    const session = await service.findSessionOrFail(sessionId);
    expect(session.title).toBe("a".repeat(30));
  });

  it("appendMessage 写 pending 消息并返回 queued 标志", async () => {
    const { sessionId } = await service.createSession({ content: "first" });
    const res = await service.appendMessage(sessionId, { content: "second" });
    expect(res.queued).toBe(true); // session 仍 running
    const pending = await service.listActivePending(sessionId);
    expect(pending).toHaveLength(2);
  });

  it("claimPending 把 pending 批量转 processing 并返回", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    await service.appendMessage(sessionId, { content: "m2" });
    const claimed = await service.claimPending(sessionId);
    expect(claimed.map((m) => m.content)).toEqual(["m1", "m2"]);
    const stillActive = await service.listActivePending(sessionId);
    expect(stillActive.every((m) => m.status === "processing")).toBe(true);
  });

  it("markProcessed 把消息转 processed 并写 processed_at", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markProcessed(claimed.map((m) => m.id));
    const pending = await service.listActivePending(sessionId);
    expect(pending).toHaveLength(0);
  });

  it("rollbackProcessingToPending 把 processing 退回 pending", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    await service.claimPending(sessionId);
    const n = await service.rollbackProcessingToPending();
    expect(n).toBe(1);
    const pending = await service.listActivePending(sessionId);
    expect(pending[0].status).toBe("pending");
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- session.service`
Expected: FAIL — `Cannot find module './session.service'`

- [ ] **Step 4: 写 SessionService**

`apps/server-agent/src/services/session.service.ts`：

```ts
import { Transactional } from "@meshbot/common";
import type {
  AppendMessageInput,
  CreateSessionInput,
} from "@meshbot/types-agent";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { PendingMessage } from "../entities/pending-message.entity";
import { Session } from "../entities/session.entity";

const TITLE_MAX = 30;

/** 会话与待处理用户消息的归属 Service。 */
@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session)
    private readonly sessions: Repository<Session>,
    @InjectRepository(PendingMessage)
    private readonly pending: Repository<PendingMessage>,
  ) {}

  /**
   * 创建会话：建 Session(running) + 写首条 pending 消息。
   * 跨两表写入 —— 用 @Transactional 包裹的私有方法。
   */
  async createSession(
    input: CreateSessionInput,
  ): Promise<{ sessionId: string }> {
    return this.createSessionInTx(input);
  }

  @Transactional()
  private async createSessionInTx(
    input: CreateSessionInput,
  ): Promise<{ sessionId: string }> {
    const session = await this.sessions.save(
      this.sessions.create({
        title: input.content.slice(0, TITLE_MAX),
        status: "running",
      }),
    );
    await this.pending.save(
      this.pending.create({
        sessionId: session.id,
        content: input.content,
        status: "pending",
      }),
    );
    return { sessionId: session.id };
  }

  /** 向已存在会话追加一条 pending 消息。单表写入，无需事务。 */
  async appendMessage(
    sessionId: string,
    input: AppendMessageInput,
  ): Promise<{ messageId: string; queued: boolean }> {
    const session = await this.findSessionOrFail(sessionId);
    const msg = await this.pending.save(
      this.pending.create({
        sessionId,
        content: input.content,
        status: "pending",
      }),
    );
    return { messageId: msg.id, queued: session.status === "running" };
  }

  /** 取会话，不存在抛 404。 */
  async findSessionOrFail(sessionId: string): Promise<Session> {
    const s = await this.sessions.findOneBy({ id: sessionId });
    if (!s) throw new NotFoundException(`Session ${sessionId} not found`);
    return s;
  }

  /** 列出会话下排队中 / 处理中的消息（pending + processing），按时间升序。 */
  listActivePending(sessionId: string): Promise<PendingMessage[]> {
    return this.pending.find({
      where: [
        { sessionId, status: "pending" },
        { sessionId, status: "processing" },
      ],
      order: { createdAt: "ASC" },
    });
  }

  /**
   * 取会话全部 pending 消息，整批转 processing 后返回。
   * 单表 update，无需事务。
   */
  async claimPending(sessionId: string): Promise<PendingMessage[]> {
    const rows = await this.pending.find({
      where: { sessionId, status: "pending" },
      order: { createdAt: "ASC" },
    });
    if (rows.length === 0) return [];
    await this.pending.update(
      { id: In(rows.map((r) => r.id)) },
      { status: "processing" },
    );
    return rows.map((r) => ({ ...r, status: "processing" }));
  }

  /** 把一批消息标记为 processed，写 processed_at。 */
  async markProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pending.update(
      { id: In(ids) },
      { status: "processed", processedAt: new Date() },
    );
  }

  /** 把一批 processing 消息退回 pending（run 出错时调用）。 */
  async rollbackToPending(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pending.update({ id: In(ids) }, { status: "pending" });
  }

  /**
   * 启动恢复：把所有遗留的 processing 消息退回 pending。
   * 进程重启时 inflight 内存丢失，让这些消息可被重新消费。
   */
  async rollbackProcessingToPending(): Promise<number> {
    const res = await this.pending.update(
      { status: "processing" },
      { status: "pending" },
    );
    return res.affected ?? 0;
  }

  /** 更新会话 status（idle / running）。 */
  async setStatus(sessionId: string, status: string): Promise<void> {
    await this.sessions.update({ id: sessionId }, { status });
  }
}
```

> `createSessionInTx` 是私有 `@Transactional()` 方法，名字以 `InTx` 结尾命中 `check:naming` 约定。`appendMessage` / `claimPending` / `markProcessed` 等是单表写入，不挂 `@Transactional()`。

- [ ] **Step 5: 写 SessionModule（先不含 RunnerService / Controller / Gateway）**

`apps/server-agent/src/session.module.ts`：

```ts
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { SessionService } from "./services/session.service";

/** 会话模块：聚合会话相关 Entity / Service / Controller / Gateway。 */
@Module({
  imports: [TxTypeOrmModule.forFeature([Session, PendingMessage])],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
```

- [ ] **Step 6: 把 SessionModule 接入 app.module**

修改 `apps/server-agent/src/app.module.ts`：import 区加 `import { SessionModule } from "./session.module";`，`imports` 数组里加 `SessionModule`（放在 `AgentModule` 之后）。

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- session.service`
Expected: PASS（6 个用例）

- [ ] **Step 8: 静态围栏 + 构建**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check`
Expected: 构建无报错；6 个围栏全 0 finding（`check:repo` 应显示 `Session` / `PendingMessage` 归属 `SessionService`）

- [ ] **Step 9: 提交**

```bash
pnpm format
git add apps/server-agent/src/dto/session.dto.ts apps/server-agent/src/services/session.service.ts apps/server-agent/src/services/session.service.spec.ts apps/server-agent/src/session.module.ts apps/server-agent/src/app.module.ts
git commit -m "feat(session): SessionService 会话与待处理消息数据层

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7：RunnerService — 内存 inflight + 消费循环

`RunnerService` 驱动流式 run。它依赖 `SessionService`（数据）+ `GraphService`（流式）+ `EventEmitter2`（发事件）。

**Files:**
- Create: `apps/server-agent/src/services/runner.service.ts`
- Modify: `apps/server-agent/src/session.module.ts`
- Modify: `apps/server-agent/src/app.module.ts`（引入 `EventEmitterModule`）
- Modify: `apps/server-agent/package.json`（加 `@nestjs/event-emitter`）
- Test: `apps/server-agent/src/services/runner.service.spec.ts`

- [ ] **Step 1: 装依赖**

Run: `pnpm --filter @meshbot/server-agent add @nestjs/event-emitter`
Expected: `apps/server-agent/package.json` 出现 `@nestjs/event-emitter`

- [ ] **Step 2: 写 RunnerService 失败测试**

`apps/server-agent/src/services/runner.service.spec.ts`（`SessionService` 与 `GraphService` 用 fake，`EventEmitter2` 用真实实例断言事件）：

```ts
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { PendingMessage } from "../entities/pending-message.entity";
import { RunnerService } from "./runner.service";

/** 内存版 SessionService 替身。 */
function fakeSessionService() {
  const store: PendingMessage[] = [];
  let seq = 0;
  return {
    store,
    async claimPending(sessionId: string) {
      const rows = store.filter(
        (m) => m.sessionId === sessionId && m.status === "pending",
      );
      for (const r of rows) r.status = "processing";
      return rows;
    },
    async markProcessed(ids: string[]) {
      for (const m of store) if (ids.includes(m.id)) m.status = "processed";
    },
    async rollbackToPending(ids: string[]) {
      for (const m of store) if (ids.includes(m.id)) m.status = "pending";
    },
    async setStatus() {},
    enqueue(sessionId: string, content: string) {
      store.push({
        id: `m${seq++}`,
        sessionId,
        content,
        status: "pending",
        createdAt: new Date(),
        processedAt: null,
      });
    },
  };
}

/** 产出固定 chunk 流的 GraphService 替身。 */
function fakeGraphService(opts?: { throwErr?: boolean }) {
  return {
    async *streamMessage() {
      if (opts?.throwErr) throw new Error("llm boom");
      yield { messageId: "msg-1", delta: "你" };
      yield { messageId: "msg-1", delta: "好" };
    },
  };
}

describe("RunnerService", () => {
  it("kick：消费 pending → 发 run.chunk/run.done → 消息转 processed", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const events: { name: string; payload: unknown }[] = [];
    emitter.onAny((name, payload) =>
      events.push({ name: String(name), payload }),
    );
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
    );
    await runner.kickAndWait("s1");
    expect(events.map((e) => e.name)).toEqual([
      "run.chunk",
      "run.chunk",
      "run.done",
    ]);
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("kick：run 期间新入队的消息，结束后自动续跑", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    let chunkCount = 0;
    emitter.on("run.chunk", () => {
      chunkCount++;
      if (chunkCount === 1) sess.enqueue("s1", "second");
    });
    sess.enqueue("s1", "first");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
    );
    await runner.kickAndWait("s1");
    expect(sess.store).toHaveLength(2);
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("出错时发 run.error 并把消息退回 pending", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const errs: unknown[] = [];
    emitter.on("run.error", (p) => errs.push(p));
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService({ throwErr: true }) as never,
      emitter,
    );
    await runner.kickAndWait("s1");
    expect(errs).toHaveLength(1);
    expect(sess.store[0].status).toBe("pending");
  });

  it("getInflight：run 进行中可取到累加快照", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    sess.enqueue("s1", "hi");
    let snapshotDuringRun: unknown = null;
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
    );
    emitter.on("run.chunk", () => {
      snapshotDuringRun = runner.getInflight("s1");
    });
    await runner.kickAndWait("s1");
    expect(snapshotDuringRun).not.toBeNull();
    expect(runner.getInflight("s1")).toBeNull(); // run 结束已清
  });
});
```

> 测试用 `kickAndWait`（await 整个消费循环）便于断言；生产代码 `kick` 是 fire-and-forget。`kick` 内部调用 `kickAndWait` 但不 await。

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- runner.service`
Expected: FAIL — `Cannot find module './runner.service'`

- [ ] **Step 4: 写 RunnerService**

`apps/server-agent/src/services/runner.service.ts`：

```ts
import { GraphService } from "@meshbot/agent";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionService } from "./session.service";

/** 进程内 run 的内存状态。 */
interface InflightRun {
  messageId: string | null;
  content: string;
  status: "streaming" | "done" | "interrupted";
  abort: AbortController;
}

/** getInflight 对外快照。 */
export interface InflightView {
  messageId: string | null;
  content: string;
  status: "streaming" | "done" | "interrupted";
}

/**
 * Agent run 执行器：进程内单例，维护内存 inflight 并驱动流式 run。
 *
 * 一个 session 同一时刻最多一个 inflight。run 结束自动检查是否还有 pending
 * 消息，有则续跑（消费循环），直到队空。
 */
@Injectable()
export class RunnerService {
  private readonly logger = new Logger(RunnerService.name);
  private readonly inflight = new Map<string, InflightRun>();

  constructor(
    private readonly sessions: SessionService,
    private readonly graph: GraphService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** 启动消费循环（fire-and-forget）。已有 inflight 则跳过（防重入）。 */
  kick(sessionId: string): void {
    if (this.inflight.has(sessionId)) return;
    void this.kickAndWait(sessionId).catch((err) => {
      this.logger.error(`run loop crashed for ${sessionId}`, err);
    });
  }

  /** 取某 session 当前 inflight 快照；无则 null。 */
  getInflight(sessionId: string): InflightView | null {
    const run = this.inflight.get(sessionId);
    if (!run) return null;
    return {
      messageId: run.messageId,
      content: run.content,
      status: run.status,
    };
  }

  /** 中断某 session 当前 run。 */
  interrupt(sessionId: string): void {
    this.inflight.get(sessionId)?.abort.abort();
  }

  /**
   * 消费循环：取 pending → 跑一次 run → 检查是否还有 pending → 续跑。
   * 测试直接 await 本方法；生产经 kick 触发不 await。
   */
  async kickAndWait(sessionId: string): Promise<void> {
    if (this.inflight.has(sessionId)) return;
    try {
      while (true) {
        const batch = await this.sessions.claimPending(sessionId);
        if (batch.length === 0) break;
        await this.runOnce(sessionId, batch);
      }
    } finally {
      await this.sessions.setStatus(sessionId, "idle");
    }
  }

  /** 跑一次 run：把一批消息拼成一次输入，流式产出并发事件。 */
  private async runOnce(
    sessionId: string,
    batch: { id: string; content: string }[],
  ): Promise<void> {
    const ids = batch.map((m) => m.id);
    const input = batch.map((m) => m.content).join("\n");
    const run: InflightRun = {
      messageId: null,
      content: "",
      status: "streaming",
      abort: new AbortController(),
    };
    this.inflight.set(sessionId, run);
    try {
      for await (const chunk of this.graph.streamMessage(
        sessionId,
        input,
        run.abort.signal,
      )) {
        run.messageId = chunk.messageId;
        run.content += chunk.delta;
        this.emitter.emit(SESSION_WS_EVENTS.runChunk, {
          sessionId,
          messageId: chunk.messageId,
          delta: chunk.delta,
        });
      }
      run.status = "done";
      await this.sessions.markProcessed(ids);
      this.emitter.emit(SESSION_WS_EVENTS.runDone, {
        sessionId,
        messageId: run.messageId ?? "",
        content: run.content,
      });
    } catch (err) {
      if (run.abort.signal.aborted) {
        run.status = "interrupted";
        this.emitter.emit(SESSION_WS_EVENTS.runInterrupted, {
          sessionId,
          messageId: run.messageId ?? "",
        });
      } else {
        await this.sessions.rollbackToPending(ids);
        this.emitter.emit(SESSION_WS_EVENTS.runError, {
          sessionId,
          messageId: run.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    } finally {
      this.inflight.delete(sessionId);
    }
  }
}
```

> 注意 `runOnce` 出错（非中断）时 `throw err` 会中止 `kickAndWait` 的 `while` 循环 —— 出错的批次已退回 pending，避免死循环立即重试同一条坏消息。测试 `"出错时发 run.error"` 据此断言。`runOnce` 是私有方法但**不是** `@Transactional()`，名字不以 `InDb`/`InTx`/`persist` 结尾 —— 符合 `check:naming`（约定只约束事务方法）。

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- runner.service`
Expected: PASS（4 个用例）

- [ ] **Step 6: 注册 RunnerService + EventEmitterModule**

`apps/server-agent/src/session.module.ts` 的 `providers` 加 `RunnerService`，`exports` 加 `RunnerService`，import 区加对应 import。`SessionModule` 需要 `GraphService` —— 它由 `AgentModule` 导出，故 `SessionModule` 的 `imports` 加 `AgentModule`：

```ts
import { AgentModule } from "@meshbot/agent";
// ...
imports: [TxTypeOrmModule.forFeature([Session, PendingMessage]), AgentModule],
providers: [SessionService, RunnerService],
exports: [SessionService, RunnerService],
```

`apps/server-agent/src/app.module.ts` 的 `imports` 加 `EventEmitterModule.forRoot()`：

```ts
import { EventEmitterModule } from "@nestjs/event-emitter";
// imports 数组里加：
EventEmitterModule.forRoot(),
```

- [ ] **Step 7: 启动恢复钩子 —— RunnerService 实现 OnModuleInit**

在 `RunnerService` 加启动回滚（进程重启把遗留 processing 退回 pending）。在 class 顶部 `implements OnModuleInit`，import `OnModuleInit`，加方法：

```ts
  /** 启动时把遗留的 processing 消息退回 pending（重启 inflight 丢失后可重跑）。 */
  async onModuleInit(): Promise<void> {
    const n = await this.sessions.rollbackProcessingToPending();
    if (n > 0) {
      this.logger.log(`启动恢复：${n} 条遗留 processing 消息已退回 pending`);
    }
  }
```

- [ ] **Step 8: 构建 + 围栏**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check`
Expected: 构建无报错；围栏全 0 finding

- [ ] **Step 9: 提交**

```bash
pnpm format
git add apps/server-agent/src/services/runner.service.ts apps/server-agent/src/services/runner.service.spec.ts apps/server-agent/src/session.module.ts apps/server-agent/src/app.module.ts apps/server-agent/package.json pnpm-lock.yaml
git commit -m "feat(session): RunnerService 内存消费循环 + 流式 run 执行

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8：SessionController — 4 个 REST 端点

`SessionController` 瘦 Controller，依赖 `SessionService`（数据）+ `RunnerService`（getInflight + kick）+ `GraphService`（getHistory）。

**Files:**
- Create: `apps/server-agent/src/controllers/session.controller.ts`
- Modify: `apps/server-agent/src/session.module.ts`
- Modify: `apps/server-agent/src/app.module.ts`（controllers 数组）
- Test: `apps/server-agent/test/e2e/session.e2e-spec.ts`

- [ ] **Step 1: 写 SessionController**

`apps/server-agent/src/controllers/session.controller.ts`：

```ts
import { GraphService } from "@meshbot/agent";
import type {
  HistoryResponse,
  PendingResponse,
} from "@meshbot/types-agent";
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { AppendMessageDto, CreateSessionDto } from "../dto/session.dto";
import { RunnerService } from "../services/runner.service";
import { SessionService } from "../services/session.service";

/** 会话 REST 端点。瘦 Controller —— 业务在 SessionService / RunnerService。 */
@Controller("api/sessions")
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly graph: GraphService,
  ) {}

  /** 创建会话：写库后异步发起 run，立即返回 sessionId。 */
  @Post()
  async create(@Body() dto: CreateSessionDto): Promise<{ sessionId: string }> {
    const result = await this.sessions.createSession(dto);
    this.runner.kick(result.sessionId);
    return result;
  }

  /** 向已存在会话追加消息；idle 则启动 run，running 则入队。 */
  @Post(":id/messages")
  async append(
    @Param("id") id: string,
    @Body() dto: AppendMessageDto,
  ): Promise<{ messageId: string; queued: boolean }> {
    const result = await this.sessions.appendMessage(id, dto);
    if (!result.queued) {
      this.runner.kick(id);
    }
    return result;
  }

  /** 取已处理历史 + 当前 inflight 快照。 */
  @Get(":id/history")
  async history(@Param("id") id: string): Promise<HistoryResponse> {
    await this.sessions.findSessionOrFail(id);
    const messages = await this.graph.getHistory(id);
    const inflight = this.runner.getInflight(id);
    return { messages, inflight };
  }

  /** 取排队中 / 处理中的用户消息。 */
  @Get(":id/pending")
  async pending(@Param("id") id: string): Promise<PendingResponse> {
    await this.sessions.findSessionOrFail(id);
    const rows = await this.sessions.listActivePending(id);
    return {
      pending: rows.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        content: m.content,
        status: m.status as PendingResponse["pending"][number]["status"],
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }
}
```

> Controller 不注入任何 Repository（`check:repo` 要求）。`append` 里 `!result.queued`（即 session 为 idle）时才 `kick` —— running 时已有 inflight，`kick` 内部也会因 `inflight.has` 防重入跳过，此处提前判断只是省一次无意义调用。

- [ ] **Step 2: 注册 Controller**

`apps/server-agent/src/session.module.ts` 加 `controllers: [SessionController]`（import `SessionController`）。

`apps/server-agent/src/app.module.ts` 的 `controllers` 数组**不动** —— `SessionController` 由 `SessionModule` 自己声明。确认 `SessionModule` 已在 `app.module.ts` 的 `imports` 中（Task 6 Step 6 已加）。

- [ ] **Step 3: 写 e2e 测试**

`apps/server-agent/test/e2e/session.e2e-spec.ts`（参照仓库已有 e2e 风格，用 `Test.createTestingModule`，sqlite `:memory:`，覆盖 4 端点的快乐路径）：

```ts
import { AgentModule } from "@meshbot/agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import request from "supertest";
import { SessionController } from "../../src/controllers/session.controller";
import { PendingMessage } from "../../src/entities/pending-message.entity";
import { Session } from "../../src/entities/session.entity";
import { RunnerService } from "../../src/services/runner.service";
import { SessionService } from "../../src/services/session.service";

describe("Session e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [Session, PendingMessage],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([Session, PendingMessage]),
        AgentModule,
      ],
      controllers: [SessionController],
      providers: [SessionService, RunnerService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/sessions 创建会话返回 sessionId", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "你好" })
      .expect(201);
    expect(typeof res.body.sessionId).toBe("string");
  });

  it("POST /api/sessions/:id/messages 追加消息", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "first" });
    const sessionId = created.body.sessionId;
    const res = await request(app.getHttpServer())
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ content: "second" })
      .expect(201);
    expect(typeof res.body.messageId).toBe("string");
  });

  it("GET /api/sessions/:id/pending 返回排队消息", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "排队消息" });
    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${created.body.sessionId}/pending`)
      .expect(200);
    expect(Array.isArray(res.body.pending)).toBe(true);
  });

  it("GET /api/sessions/:id/history 返回 messages 与 inflight 字段", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "历史测试" });
    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${created.body.sessionId}/history`)
      .expect(200);
    expect(res.body).toHaveProperty("messages");
    expect(res.body).toHaveProperty("inflight");
  });
});
```

> e2e 测试模块不 import 全局 `JwtAuthGuard` / `ResponseInterceptor`，故端点不鉴权、返回裸 body（与单元测试隔离一致 —— 参照仓库已有 e2e 做法）。若 `RunnerService` 因无 ModelConfig 在后台 `kick` 时报错，错误只进日志不影响断言（`kick` 是 fire-and-forget 且 catch 了异常）。

- [ ] **Step 4: 运行 e2e，确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- session.e2e`
Expected: PASS（4 个用例）

- [ ] **Step 5: 构建 + 围栏**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check`
Expected: 构建无报错；围栏全 0 finding（`check:repo` 的 `NON_SERVICE_INJECT` 应为 0 —— Controller 没注入 Repo）

- [ ] **Step 6: 提交**

```bash
pnpm format
git add apps/server-agent/src/controllers/session.controller.ts apps/server-agent/src/session.module.ts apps/server-agent/test/e2e/session.e2e-spec.ts
git commit -m "feat(session): SessionController 4 个 REST 端点

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9：SessionGateway — socket.io 实时通道

server-agent 当前没装 socket.io。本 Task 装依赖 + 建 Gateway，复用 `libs/common` 的 WS 框架。

**Files:**
- Create: `apps/server-agent/src/ws/session.gateway.ts`
- Modify: `apps/server-agent/src/session.module.ts`
- Modify: `apps/server-agent/package.json`（socket.io 依赖）
- Test: `apps/server-agent/src/ws/session.gateway.spec.ts`

- [ ] **Step 1: 装依赖**

Run: `pnpm --filter @meshbot/server-agent add @nestjs/websockets @nestjs/platform-socket.io socket.io`
Expected: 三个包进 `apps/server-agent/package.json` dependencies

- [ ] **Step 2: 写 Gateway 失败测试**

`apps/server-agent/src/ws/session.gateway.spec.ts`（不起真实 socket server，直接测方法逻辑：subscribe 调 join + 回推 inflight、interrupt 调 runner、`@OnEvent` 转发）：

```ts
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type { Socket } from "socket.io";
import { SessionGateway } from "./session.gateway";

function fakeSocket(): Socket & { joined: string[]; emitted: unknown[] } {
  const joined: string[] = [];
  const emitted: unknown[] = [];
  return {
    joined,
    emitted,
    data: { user: { sub: "u1" }, traceId: "t1" },
    join: (room: string) => joined.push(room),
    emit: (...args: unknown[]) => emitted.push(args),
  } as never;
}

describe("SessionGateway", () => {
  it("subscribe：join 房间，有 inflight 则回推快照", () => {
    const runner = {
      getInflight: () => ({
        messageId: "m1",
        content: "部分",
        status: "streaming" as const,
      }),
      interrupt: jest.fn(),
    };
    const gw = new SessionGateway({} as never, runner as never);
    const sock = fakeSocket();
    gw.handleSubscribe({ sessionId: "s1" }, sock);
    expect(sock.joined).toEqual(["s1"]);
    expect(sock.emitted).toHaveLength(1);
  });

  it("subscribe：无 inflight 不回推", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    const sock = fakeSocket();
    gw.handleSubscribe({ sessionId: "s1" }, sock);
    expect(sock.emitted).toHaveLength(0);
  });

  it("interrupt：调 runner.interrupt", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    gw.handleInterrupt({ sessionId: "s1" });
    expect(runner.interrupt).toHaveBeenCalledWith("s1");
  });

  it("onRunChunk：把事件转发到对应房间", () => {
    const runner = { getInflight: () => null, interrupt: jest.fn() };
    const gw = new SessionGateway({} as never, runner as never);
    const toEmit: unknown[] = [];
    (gw as unknown as { server: unknown }).server = {
      to: () => ({ emit: (...a: unknown[]) => toEmit.push(a) }),
    };
    gw.onRunChunk({ sessionId: "s1", messageId: "m1", delta: "x" });
    expect(toEmit).toHaveLength(1);
    expect(toEmit[0]).toEqual([SESSION_WS_EVENTS.runChunk, {
      sessionId: "s1",
      messageId: "m1",
      delta: "x",
    }]);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- session.gateway`
Expected: FAIL — `Cannot find module './session.gateway'`

- [ ] **Step 4: 写 SessionGateway**

`apps/server-agent/src/ws/session.gateway.ts`：

```ts
import {
  BaseWebSocketGateway,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  type RunChunkEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunInterruptedEvent,
  SESSION_WS_EVENTS,
  SESSION_WS_NAMESPACE,
  type SessionTopic,
} from "@meshbot/types-agent";
import { UseFilters, UseGuards } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { RunnerService } from "../services/runner.service";

/**
 * 会话流式 WebSocket Gateway。端点：ws://<host>/ws/session
 *
 * - 复用 BaseWebSocketGateway 的握手鉴权 + 未鉴权宽限回收
 * - 客户端 session.subscribe：join 以 sessionId 为名的房间，并立即回推
 *   当前 inflight 快照（保证刷新页面能拼出未完成消息）
 * - RunnerService 经 EventEmitter2 发的 run.* 事件，由本 Gateway @OnEvent
 *   监听后转发到对应房间
 */
@WebSocketGateway({ namespace: SESSION_WS_NAMESPACE, cors: true })
@UseFilters(WsExceptionFilter)
export class SessionGateway extends BaseWebSocketGateway {
  constructor(
    private readonly jwt: JwtService,
    private readonly runner: RunnerService,
  ) {
    super();
  }

  protected jwtVerify(token: string): unknown {
    return this.jwt.verify(token);
  }

  /** 订阅会话：join 房间 + 回推 inflight 快照（若有）。 */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(SESSION_WS_EVENTS.subscribe)
  handleSubscribe(
    @MessageBody() body: SessionTopic,
    @ConnectedSocket() client: Socket,
  ): void {
    client.join(body.sessionId);
    const inflight = this.runner.getInflight(body.sessionId);
    if (inflight) {
      client.emit(SESSION_WS_EVENTS.runChunk, {
        sessionId: body.sessionId,
        messageId: inflight.messageId ?? "",
        delta: inflight.content,
      });
    }
  }

  /** 中断会话当前 run。 */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(SESSION_WS_EVENTS.interrupt)
  handleInterrupt(@MessageBody() body: SessionTopic): void {
    this.runner.interrupt(body.sessionId);
  }

  /** RunnerService → run.chunk → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runChunk)
  onRunChunk(payload: RunChunkEvent): void {
    this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runChunk, payload);
  }

  /** RunnerService → run.done → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runDone)
  onRunDone(payload: RunDoneEvent): void {
    this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runDone, payload);
  }

  /** RunnerService → run.interrupted → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runInterrupted)
  onRunInterrupted(payload: RunInterruptedEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runInterrupted, payload);
  }

  /** RunnerService → run.error → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runError)
  onRunError(payload: RunErrorEvent): void {
    this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runError, payload);
  }
}
```

> `handleSubscribe` 回推 inflight 时用 `run.chunk` 事件复用前端的累加逻辑：把已累加的 `content` 整体作为一个 `delta` 推出去，前端按 `messageId` 累加即可拼出完整。`SessionGateway` 不注入 Repository（`check:repo`）。

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- session.gateway`
Expected: PASS（4 个用例）

- [ ] **Step 6: 注册 Gateway**

`apps/server-agent/src/session.module.ts` 的 `providers` 加 `SessionGateway`，import `SessionGateway`。`SessionGateway` 需要 `JwtService` —— 它由 `AuthModule` 的 `JwtModule` 提供。`SessionModule` 的 `imports` 加 `AuthModule`：

```ts
import { AuthModule } from "./auth.module";
// imports 数组加 AuthModule
```

> `AuthModule` 已 `exports: [AuthService]` 但 `JwtModule` 默认不导出。检查 `auth.module.ts`：若 `JwtModule` 不在 `exports`，给 `AuthModule` 的 `exports` 加 `JwtModule`（`JwtModule.register` 返回的动态模块可直接放 exports）。这是本 Task 唯一对 `auth.module.ts` 的改动。

- [ ] **Step 7: 构建 + 围栏**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check`
Expected: 构建无报错；围栏全 0 finding

- [ ] **Step 8: 手动冒烟（可选但推荐）**

启动 server-agent，确认 socket.io 端点起来：
Run: `pnpm dev:server-agent`，启动后日志应无 WS 相关报错；Ctrl-C
Expected: 无 `@WebSocketGateway` 初始化报错

- [ ] **Step 9: 提交**

```bash
pnpm format
git add apps/server-agent/src/ws/session.gateway.ts apps/server-agent/src/ws/session.gateway.spec.ts apps/server-agent/src/session.module.ts apps/server-agent/src/auth.module.ts apps/server-agent/package.json pnpm-lock.yaml
git commit -m "feat(session): SessionGateway socket.io 流式实时通道

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10：前端 REST 封装 + socket 单例

**Files:**
- Create: `apps/web-agent/src/rest/session.ts`
- Create: `apps/web-agent/src/lib/socket.ts`
- Modify: `apps/web-agent/src/rest/index.ts`
- Modify: `apps/web-agent/package.json`（`socket.io-client`）

无单测（前端薄封装，由 Task 11/12 的页面集成间接覆盖；本仓库前端无既有单测惯例）。

- [ ] **Step 1: 装依赖**

Run: `pnpm --filter @meshbot/web-agent add socket.io-client`
Expected: `apps/web-agent/package.json` 出现 `socket.io-client`

- [ ] **Step 2: 写 REST 封装**

`apps/web-agent/src/rest/session.ts`：

```ts
import { apiClient } from "@meshbot/web-common";
import type {
  HistoryResponse,
  PendingResponse,
} from "@meshbot/types-agent";

/** 创建会话，返回 sessionId。 */
export async function createSession(content: string): Promise<string> {
  const { data } = await apiClient.post<{ sessionId: string }>(
    "/api/sessions",
    { content },
  );
  return data.sessionId;
}

/** 向会话追加一条消息。 */
export async function appendMessage(
  sessionId: string,
  content: string,
): Promise<{ messageId: string; queued: boolean }> {
  const { data } = await apiClient.post<{
    messageId: string;
    queued: boolean;
  }>(`/api/sessions/${sessionId}/messages`, { content });
  return data;
}

/** 取会话已处理历史 + inflight。 */
export async function fetchHistory(
  sessionId: string,
): Promise<HistoryResponse> {
  const { data } = await apiClient.get<HistoryResponse>(
    `/api/sessions/${sessionId}/history`,
  );
  return data;
}

/** 取会话排队中的用户消息。 */
export async function fetchPending(
  sessionId: string,
): Promise<PendingResponse> {
  const { data } = await apiClient.get<PendingResponse>(
    `/api/sessions/${sessionId}/pending`,
  );
  return data;
}
```

> `apiClient` 的响应拦截器返回 `response`；后端成功响应走统一 envelope（`{ success, data, ... }`）。**实施检查点**：确认 `apiClient` 是否已自动解包 envelope。若没有，上面 `data.sessionId` 需改为 `data.data.sessionId` 等。检查方式：看 `apps/web-agent/src/rest/model-config.ts` 现有调用 —— 它直接用 `data` 不解包，说明 server-agent 端点未套 envelope 或 `apiClient` 已解包。**与现有 `model-config.ts` 保持一致即可**。

- [ ] **Step 3: 写 socket 单例**

`apps/web-agent/src/lib/socket.ts`：

```ts
import { getAccessToken, getBrowserApiBaseUrl } from "@meshbot/web-common";
import { SESSION_WS_NAMESPACE } from "@meshbot/types-agent";
import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * 获取会话 namespace 的 socket.io 单例。
 *
 * 握手时带 JWT token；socket.io-client 默认自动重连。
 * 连接 URL = API base + /ws/session namespace。
 */
export function getSessionSocket(): Socket {
  if (socket) return socket;
  const base = getBrowserApiBaseUrl();
  socket = io(`${base}/${SESSION_WS_NAMESPACE}`, {
    transports: ["websocket"],
    auth: { token: getAccessToken() ?? "" },
    autoConnect: true,
  });
  return socket;
}

/** 断开并清空 socket 单例。 */
export function disconnectSessionSocket(): void {
  socket?.disconnect();
  socket = null;
}
```

- [ ] **Step 4: 导出**

`apps/web-agent/src/rest/index.ts` 末尾加：

```ts
export {
  appendMessage,
  createSession,
  fetchHistory,
  fetchPending,
} from "./session";
```

- [ ] **Step 5: 构建确认**

Run: `pnpm --filter @meshbot/web-agent build`
Expected: 构建无报错（静态导出成功）

- [ ] **Step 6: 提交**

```bash
pnpm format
git add apps/web-agent/src/rest/session.ts apps/web-agent/src/lib/socket.ts apps/web-agent/src/rest/index.ts apps/web-agent/package.json pnpm-lock.yaml
git commit -m "feat(web-session): 前端会话 REST 封装与 socket.io 单例

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11：首页发送 → 创建会话 → 跳转

**Files:**
- Modify: `apps/web-agent/src/app/page.tsx`

- [ ] **Step 1: 改 page.tsx 的 onSend**

`apps/web-agent/src/app/page.tsx`：顶部 import 区加：

```ts
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createSession } from "@/rest/session";
```

`Home` 组件内，`const t = useTranslations("home");` 之后加：

```ts
  const router = useRouter();
  const [sending, setSending] = useState(false);

  const handleSend = async (msg: string) => {
    if (sending) return;
    setSending(true);
    try {
      const sessionId = await createSession(msg);
      router.push(`/session?id=${sessionId}`);
    } catch (err) {
      console.error("创建会话失败", err);
      setSending(false);
    }
  };
```

把底部 `<ChatInput onSend={(msg) => console.log("send:", msg)} ... />` 改为：

```tsx
        <ChatInput
          onSend={handleSend}
          isLoading={sending}
          modelName="Flash · Medium"
          tokenUsage={{ current: 12, max: 128 }}
        />
```

> 跳转成功后页面卸载，无需 `setSending(false)`；仅失败分支恢复。

- [ ] **Step 2: 构建确认**

Run: `pnpm --filter @meshbot/web-agent build`
Expected: 构建无报错

- [ ] **Step 3: 手动冒烟**

需要 server-agent 跑着 + 已配置 ModelConfig + 已登录。
Run: `pnpm dev:server-agent`（一个终端）、`pnpm dev:web-agent`（另一个）
打开 `http://localhost:3001`，登录后在首页输入文字点发送。
Expected: 浏览器跳转到 `/session?id=<uuid>`（会话页本 Task 还没建，显示 404 或空白属正常 —— 下个 Task 建）

- [ ] **Step 4: 提交**

```bash
pnpm format
git add apps/web-agent/src/app/page.tsx
git commit -m "feat(web-session): 首页发送创建会话并跳转

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12：会话页 — 订阅 + 流式渲染

会话页是静态页（`app/session/page.tsx`），id 经 query 传，用 `useSearchParams()` 读，包 `<Suspense>`。

**Files:**
- Create: `apps/web-agent/src/components/session/message-list.tsx`
- Create: `apps/web-agent/src/app/session/page.tsx`

- [ ] **Step 1: 写消息时间线组件**

`apps/web-agent/src/components/session/message-list.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";

/** 时间线上的一条消息（统一视图模型）。 */
export interface TimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  pending?: boolean;
  streaming?: boolean;
}

interface MessageListProps {
  messages: TimelineMessage[];
}

/** 会话消息时间线。user 右对齐，assistant 左对齐。 */
export function MessageList({ messages }: MessageListProps) {
  return (
    <div className="flex flex-col gap-3">
      {messages
        .filter((m) => m.role !== "system")
        .map((m) => (
          <div
            key={m.id}
            className={cn(
              "max-w-[80%] rounded-lg px-3 py-2 text-sm",
              m.role === "user"
                ? "self-end bg-accent text-foreground"
                : "self-start bg-muted text-foreground",
            )}
          >
            {m.content}
            {m.streaming && (
              <span className="ml-1 animate-pulse text-muted-foreground">
                ▋
              </span>
            )}
            {m.pending && (
              <span className="ml-2 text-xs text-muted-foreground">
                排队中
              </span>
            )}
          </div>
        ))}
    </div>
  );
}
```

- [ ] **Step 2: 写会话页**

`apps/web-agent/src/app/session/page.tsx`：

```tsx
"use client";

import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type {
  RunChunkEvent,
  RunDoneEvent,
  RunErrorEvent,
  RunInterruptedEvent,
} from "@meshbot/types-agent";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ChatInput } from "@/components/common/chat-input";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import {
  MessageList,
  type TimelineMessage,
} from "@/components/session/message-list";
import { disconnectSessionSocket, getSessionSocket } from "@/lib/socket";
import { appendMessage, fetchHistory, fetchPending } from "@/rest/session";

function SessionView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionId = searchParams.get("id");
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [running, setRunning] = useState(false);
  const messagesRef = useRef<TimelineMessage[]>([]);

  /** 单一写入口：同步更新 ref 与 state。 */
  const apply = useCallback(
    (next: (prev: TimelineMessage[]) => TimelineMessage[]) => {
      messagesRef.current = next(messagesRef.current);
      setMessages(messagesRef.current);
    },
    [],
  );

  /** 按 messageId 累加流式 delta；不存在则新建 assistant 气泡。 */
  const upsertChunk = useCallback(
    (messageId: string, delta: string, streaming: boolean) => {
      apply((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) {
          return [
            ...prev,
            { id: messageId, role: "assistant", content: delta, streaming },
          ];
        }
        const copy = [...prev];
        const existing = copy[idx];
        copy[idx] = {
          ...existing,
          content: streaming ? existing.content + delta : delta,
          streaming,
        };
        return copy;
      });
    },
    [apply],
  );

  useEffect(() => {
    if (!sessionId) {
      router.replace("/");
      return;
    }
    let cancelled = false;

    // 初始加载：并发拉 history + pending
    void Promise.all([
      fetchHistory(sessionId),
      fetchPending(sessionId),
    ]).then(([history, pending]) => {
      if (cancelled) return;
      const initial: TimelineMessage[] = history.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
      }));
      if (history.inflight) {
        initial.push({
          id: history.inflight.messageId ?? "inflight",
          role: "assistant",
          content: history.inflight.content,
          streaming: history.inflight.status === "streaming",
        });
        setRunning(history.inflight.status === "streaming");
      }
      for (const p of pending.pending) {
        initial.push({
          id: p.id,
          role: "user",
          content: p.content,
          pending: true,
        });
      }
      messagesRef.current = initial;
      setMessages(initial);
    });

    // 连 socket 订阅
    const socket = getSessionSocket();
    const subscribe = () =>
      socket.emit(SESSION_WS_EVENTS.subscribe, { sessionId });
    socket.on("connect", subscribe);
    if (socket.connected) subscribe();

    socket.on(SESSION_WS_EVENTS.runChunk, (e: RunChunkEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      upsertChunk(e.messageId, e.delta, true);
    });
    socket.on(SESSION_WS_EVENTS.runDone, (e: RunDoneEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(false);
      apply((prev) =>
        prev.map((m) =>
          m.id === e.messageId
            ? { ...m, content: e.content, streaming: false }
            : m,
        ),
      );
    });
    socket.on(SESSION_WS_EVENTS.runInterrupted, (e: RunInterruptedEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(false);
      apply((prev) =>
        prev.map((m) =>
          m.id === e.messageId ? { ...m, streaming: false } : m,
        ),
      );
    });
    socket.on(SESSION_WS_EVENTS.runError, (e: RunErrorEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(false);
      apply((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: `出错：${e.error}`,
        },
      ]);
    });

    return () => {
      cancelled = true;
      socket.off("connect", subscribe);
      socket.off(SESSION_WS_EVENTS.runChunk);
      socket.off(SESSION_WS_EVENTS.runDone);
      socket.off(SESSION_WS_EVENTS.runInterrupted);
      socket.off(SESSION_WS_EVENTS.runError);
      disconnectSessionSocket();
    };
  }, [sessionId, router, apply, upsertChunk]);

  /** 会话页继续发送：立即插 pending 气泡，调追加接口。 */
  const handleSend = useCallback(
    async (msg: string) => {
      if (!sessionId) return;
      const tempId = `local-${Date.now()}`;
      apply((prev) => [
        ...prev,
        { id: tempId, role: "user", content: msg, pending: true },
      ]);
      try {
        await appendMessage(sessionId, msg);
      } catch (err) {
        console.error("追加消息失败", err);
      }
    },
    [sessionId, apply],
  );

  /** Stop 按钮：经 socket 发中断信号。 */
  const handleInterrupt = useCallback(() => {
    if (!sessionId) return;
    getSessionSocket().emit(SESSION_WS_EVENTS.interrupt, { sessionId });
  }, [sessionId]);

  return (
    <AppShellLayout>
      <div className="flex w-full max-w-[620px] flex-1 flex-col">
        <MessageList messages={messages} />
      </div>
      <div className="sticky bottom-4 mt-auto bg-background pt-4">
        <ChatInput
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          isLoading={running}
        />
      </div>
    </AppShellLayout>
  );
}

/** 会话页。useSearchParams 需 Suspense 边界（静态导出要求）。 */
export default function SessionPage() {
  return (
    <Suspense fallback={null}>
      <SessionView />
    </Suspense>
  );
}
```

> `ChatInput` 的 `isLoading` 为 `true` 时显示 Stop 按钮、隐藏发送按钮 —— 这是 `ChatInput` 既有行为。需求要「run 进行中仍可继续输入并发送」：`ChatInput` 的输入框（contentEditable）本身从不 disabled，但 `isLoading=true` 时发送按钮被 Stop 替换，无法点发送。**实施检查点**：若要 run 进行中也能点发送，需小改 `ChatInput` —— 同时显示发送 + Stop，或 Enter 键发送不受 `isLoading` 拦。最小改法：`ChatInput` 的 `handleSend` 去掉 `if (... || isLoading) return;` 里的 `isLoading` 条件，并让 Enter 始终可发送。本 Task Step 3 处理。

- [ ] **Step 3: 微调 ChatInput 允许 run 中发送**

`apps/web-agent/src/components/common/chat-input.tsx`：`handleSend` 当前是：
```ts
    if (!trimmed || isLoading) return;
```
改为（run 进行中仍允许发送，消息会进排队）：
```ts
    if (!trimmed) return;
```

并在 `isLoading` 为 true 的渲染分支里，**同时**渲染发送按钮和 Stop 按钮。把 `{isLoading ? (<Stop.../>) : (<Send.../>)}` 改为两个按钮并存：

```tsx
        {isLoading && (
          <button
            type="button"
            onClick={handleInterrupt}
            className="flex h-8 w-8 shrink-0 items-center justify-center text-destructive transition-colors hover:text-destructive/80"
            title="Stop generating"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
        )}
        <button
          type="button"
          onClick={handleSend}
          disabled={!hasContent}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center transition-colors",
            hasContent
              ? "text-foreground hover:text-foreground/80"
              : "text-muted-foreground",
          )}
          title="Send message"
        >
          <Send className="h-4 w-4" />
        </button>
```

> 这样首页（`isLoading=sending` 短暂为 true）行为不变；会话页 run 进行中 Stop + 发送并存。

- [ ] **Step 4: 构建确认**

Run: `pnpm --filter @meshbot/web-agent build`
Expected: 构建无报错；产物 `out/session.html` 存在（静态页）

- [ ] **Step 5: 端到端手动冒烟**

需要：server-agent 跑着、已配置可用 ModelConfig、已登录。
Run: `pnpm dev:server-agent` + `pnpm dev:web-agent`
打开 `http://localhost:3001`，登录 → 首页输入文字发送 → 跳到 `/session?id=xxx` → 观察 assistant 回复逐 token 出现。
再在会话页输入第二条消息发送 → 观察其作为「排队中」气泡出现，当前 run 结束后被消费。
run 进行中点 Stop → 观察流式停止。
Expected: 流式显示正常；排队语义正常;中断生效。

- [ ] **Step 6: 提交**

```bash
pnpm format
git add apps/web-agent/src/components/session/message-list.tsx apps/web-agent/src/app/session/page.tsx apps/web-agent/src/components/common/chat-input.tsx
git commit -m "feat(web-session): 会话页 socket 订阅与流式渲染

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13：静态托管 SPA fallback 检查 + 全量回归

确认 `/session?id=xxx` 在 server-agent 自托管下刷新不 404，并跑全量回归。

**Files:**
- 可能 Modify: `apps/server-agent/src/static.module.ts`

- [ ] **Step 1: 验证静态托管对 /session 的行为**

构建 web-agent 静态产物，启动 server-agent（API-only 时它会托管 `out/`）：
Run: `pnpm --filter @meshbot/web-agent build && pnpm dev:server-agent`
浏览器直接访问 `http://localhost:3100/session?id=test`（绕过首页直达，模拟刷新）。
Expected：返回 `session.html` 页面（Next 静态导出对 `app/session/page.tsx` 产出 `out/session.html`）。

- [ ] **Step 2: 若 404 — 加 SPA fallback**

Next.js 静态导出对 `app/session/page.tsx` 产出 `session.html`（非目录形式），`ServeStaticModule` 默认能命中 `/session` → `session.html`。**若 Step 1 已返回页面，跳过本步，本 Task 不改 static.module.ts。**

若返回 404，在 `static.module.ts` 的 `ServeStaticModule.forRoot` 配置加 `serveStaticOptions` 的 `extensions`：

```ts
        ServeStaticModule.forRoot({
          rootPath,
          serveRoot: "/",
          serveStaticOptions: { extensions: ["html"] },
        }),
```

`extensions: ["html"]` 让 `/session` 自动尝试 `/session.html`。重跑 Step 1 验证。

- [ ] **Step 3: 全量类型检查 + 构建 + 测试 + 围栏**

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @meshbot/agent test
pnpm check
```

Expected: 全部通过 —— `typecheck` 无错、`build` 拓扑构建成功、Jest 全绿、agent vitest 全绿、6 个围栏 0 finding。

> 若 `pnpm test`（root Jest）未覆盖新加的 server-agent spec，确认 root jest 配置的 testMatch 涵盖 `apps/server-agent/**/*.spec.ts` 与 `test/e2e/*.e2e-spec.ts`；本仓库 root jest 已覆盖 server-agent，新文件应自动纳入。

- [ ] **Step 4: 提交（若 Step 2 改了文件）**

```bash
pnpm format
git add apps/server-agent/src/static.module.ts
git commit -m "fix(session): 静态托管 /session 路径 SPA fallback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

若本 Task 未改任何文件（Step 1 已通过），无需提交。

- [ ] **Step 5: 更新 CLAUDE.md 表归属表（可选收尾）**

`.claude/CLAUDE.md` 的「表归属」表里，server-agent 行的 Entity 从 `User / Setting / ModelConfig` 补为 `User / Setting / ModelConfig / Session / PendingMessage`。提交：

```bash
git add .claude/CLAUDE.md
git commit -m "docs: 表归属表补充 Session / PendingMessage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## 完成标准

- 首页输入文字发送 → `POST /api/sessions` 创建会话 → 写入 `sessions` + `pending_messages` 表 → 返回 sessionId
- 创建后异步发起流式 Agent run（真实 LLM，`initChatModel` 多供应商）
- 前端跳转 `/session?id=<sessionId>`，连 socket.io 订阅，token 级流式显示
- 会话 run 进行中继续发消息 → 进入 `pending` 排队 → 当前 run 结束后整批消费
- 流式过程可经 Stop 按钮中断
- 刷新会话页：`history`（含 inflight）+ `pending` 两接口 + 订阅时 inflight 回推，拼出完整时间线
- `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm check` 全绿
