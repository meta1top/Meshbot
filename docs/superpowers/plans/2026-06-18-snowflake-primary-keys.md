# Snowflake Primary Keys 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 15 张表的主键从 UUID / 手动字符串全部迁移为雪花 ID，并引入 `SnowflakeBaseEntity` 基类 + `check:pk` 围栏保证未来新表自动遵守。

**Architecture:** 新增 `libs/common/src/entities/snowflake-base.entity.ts` 抽象基类（`@BeforeInsert` 自动生成雪花 ID），所有 entity 继承它替代原有 UUID 主键声明；server-agent 用 TypeORM 迁移 DROP+CREATE 重建（数据可清空），server-main 用 DDL SQL 文件 DROP+CREATE；`check:pk` 脚本扫描全仓 `*.entity.ts` 确保所有 `@Entity` 类都继承基类。

**Tech Stack:** TypeORM + TypeScript `ts-morph` + tsx + Jest

## Global Constraints

- **数据可清空**：迁移不做 backfill，只 DROP+CREATE，`~/.meshbot/agent.db` 可直接删除重建
- 主键类型：`VARCHAR(20)` 不是 `CHAR(36)`；不使用 `DEFAULT gen_random_uuid()`
- 所有 entity 必须 `extends SnowflakeBaseEntity`；不得有裸 `@PrimaryGeneratedColumn` 或裸 `@PrimaryColumn`（`snowflake-base.entity.ts` 本体除外）
- TypeORM 迁移文件命名：`<timestamp>-<PascalCase>.ts`，timestamp = `1780500000000`
- server-main DDL 文件：`apps/server-main/migrations/202606181200-snowflake-primary-keys.sql`
- `check:pk` 新 npm script：`"check:pk": "tsx scripts/check-pk.ts"`；追加进 `check` 与 `check:parallel`；支持 `--strict` 选项（CI 用）
- 禁止数据库级外键约束（项目全局约定）
- 公开方法含中文 JSDoc

---

## 文件映射

| 操作 | 路径 |
|------|------|
| 新建 | `libs/common/src/entities/snowflake-base.entity.ts` |
| 新建 | `libs/common/src/entities/index.ts` |
| 修改 | `libs/common/src/index.ts` |
| 修改 | `apps/server-agent/src/entities/session.entity.ts` |
| 修改 | `apps/server-agent/src/entities/llm-call.entity.ts` |
| 修改 | `apps/server-agent/src/entities/model-config.entity.ts` |
| 修改 | `apps/server-agent/src/entities/pending-message.entity.ts` |
| 修改 | `apps/server-agent/src/entities/cron-job.entity.ts` |
| 修改 | `apps/server-agent/src/services/schedule.service.ts` |
| 修改 | `apps/server-agent/src/entities/cloud-identity.entity.ts` |
| 修改 | `apps/server-agent/src/entities/setting.entity.ts` |
| 修改 | `apps/server-agent/src/entities/session-message.entity.ts` |
| 修改 | `apps/server-agent/src/services/session-message.service.ts` |
| 新建 | `apps/server-agent/src/migrations/1780500000000-SnowflakePrimaryKeys.ts` |
| 修改 | `libs/main/src/entities/app-user.entity.ts` |
| 修改 | `libs/main/src/entities/organization.entity.ts` |
| 修改 | `libs/main/src/entities/membership.entity.ts` |
| 修改 | `libs/main/src/entities/invitation.entity.ts` |
| 修改 | `libs/main/src/entities/conversation.entity.ts` |
| 修改 | `libs/main/src/entities/conversation-member.entity.ts` |
| 修改 | `libs/main/src/entities/message.entity.ts` |
| 新建 | `apps/server-main/migrations/202606181200-snowflake-primary-keys.sql` |
| 新建 | `scripts/check-pk.ts` |
| 新建 | `scripts/check-pk.spec.ts` |
| 修改 | `package.json`（根） |

---

### Task 1: SnowflakeBaseEntity 基类 + libs/common 导出

**Files:**
- Create: `libs/common/src/entities/snowflake-base.entity.ts`
- Create: `libs/common/src/entities/index.ts`
- Modify: `libs/common/src/index.ts`

**Interfaces:**
- Produces: `SnowflakeBaseEntity`（`abstract class`），从 `@meshbot/common` 导出

- [ ] **Step 1: 创建 snowflake-base.entity.ts**

```typescript
// libs/common/src/entities/snowflake-base.entity.ts
import { BeforeInsert, PrimaryColumn } from "typeorm";
import { generateSnowflakeId } from "../utils/snowflake";

/** 所有 Entity 的雪花 ID 主键基类。@BeforeInsert 自动生成 19-20 位十进制字符串。 */
export abstract class SnowflakeBaseEntity {
  @PrimaryColumn({ type: "varchar", length: 20 })
  id!: string;

  @BeforeInsert()
  protected generateId() {
    if (!this.id) this.id = generateSnowflakeId();
  }
}
```

- [ ] **Step 2: 创建 entities/index.ts**

```typescript
// libs/common/src/entities/index.ts
export { SnowflakeBaseEntity } from "./snowflake-base.entity";
```

- [ ] **Step 3: 追加导出到 libs/common/src/index.ts**

在文件末尾追加一行：

```typescript
export * from "./entities";
```

- [ ] **Step 4: 类型检查**

```bash
cd /path/to/meshbot
pnpm --filter @meshbot/common typecheck
```

预期：0 错误。

- [ ] **Step 5: Commit**

```bash
git add libs/common/src/entities/ libs/common/src/index.ts
git commit -m "feat(common): 新增 SnowflakeBaseEntity 抽象基类（varchar(20) PK + @BeforeInsert）"
```

---

### Task 2: server-agent 普通 entity 改造 + schedule.service.ts

5 个普通 entity（session / llm-call / model-config / pending-message / cron-job）全部换成继承基类。`schedule.service.ts` 删去手动 `randomUUID()`。

**Files:**
- Modify: `apps/server-agent/src/entities/session.entity.ts`
- Modify: `apps/server-agent/src/entities/llm-call.entity.ts`
- Modify: `apps/server-agent/src/entities/model-config.entity.ts`
- Modify: `apps/server-agent/src/entities/pending-message.entity.ts`
- Modify: `apps/server-agent/src/entities/cron-job.entity.ts`
- Modify: `apps/server-agent/src/services/schedule.service.ts`

**Interfaces:**
- Consumes: `SnowflakeBaseEntity` from `@meshbot/common`
- Produces: 5 个 entity 类，主键由 `@BeforeInsert` 自动生成

- [ ] **Step 1: 修改 session.entity.ts**

完整替换文件内容（去掉 `PrimaryGeneratedColumn`，改继承基类，其余字段不变）：

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import type { SessionStatus } from "@meshbot/types-agent";
import { Column, CreateDateColumn, Entity, Index, UpdateDateColumn } from "typeorm";

/** 会话表。id 同时作为 LangGraph thread_id 与 socket.io room id。 */
@Entity("sessions")
@Index("uq_sessions_im_companion", ["cloudUserId", "imConversationId"], {
  unique: true,
  where: "kind = 'im'",
})
export class Session extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column()
  title!: string;

  @Column({ type: "varchar", default: "idle" })
  status!: SessionStatus;

  @Column({ name: "pinned_at", type: "datetime", nullable: true })
  pinnedAt!: Date | null;

  @Column({ name: "title_generated", default: false })
  titleGenerated!: boolean;

  @Column({ type: "varchar", default: "user" })
  kind!: "user" | "im";

  @Column({ name: "im_conversation_id", type: "text", nullable: true })
  imConversationId!: string | null;

  @Column({ name: "im_conv_type", type: "varchar", nullable: true })
  imConvType!: "channel" | "dm" | null;

  @Column({ name: "agent_enabled", type: "boolean", default: true })
  agentEnabled!: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

- [ ] **Step 2: 修改 llm-call.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity } from "typeorm";

/**
 * 一次 LLM 调用的观测记录。
 * 每次 supervisor 节点跑完 model.stream 落一行；用于会话累计 token 与单条消息 token 明细。
 */
@Entity("llm_calls")
export class LlmCall extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ name: "session_id" })
  sessionId!: string;

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

  @Column({ name: "cache_read_tokens", type: "integer", default: 0 })
  cacheReadTokens!: number;

  @Column({ name: "cache_creation_tokens", type: "integer", default: 0 })
  cacheCreationTokens!: number;

  @Column({ name: "reasoning_tokens", type: "integer", default: 0 })
  reasoningTokens!: number;

  @Column({ name: "duration_ms", type: "integer", default: 0 })
  durationMs!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
```

- [ ] **Step 3: 修改 model-config.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

@Entity("model_configs")
export class ModelConfig extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ name: "provider_type" })
  providerType!: string;

  @Column()
  name!: string;

  @Column()
  model!: string;

  @Column({ name: "api_key" })
  apiKey!: string;

  @Column({ name: "base_url", default: "" })
  baseUrl!: string;

  @Column({ default: true })
  enabled!: boolean;

  @Column({ name: "context_window", type: "int", default: 128_000 })
  contextWindow!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

- [ ] **Step 4: 修改 pending-message.entity.ts**

```typescript
import type { PendingMessageStatus } from "@meshbot/types-agent";
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity } from "typeorm";

/** 待处理用户消息表。按 session 排队，run 结束后整批取出处理。 */
@Entity("pending_messages")
export class PendingMessage extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ name: "session_id" })
  sessionId!: string;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: PendingMessageStatus;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @Column({ name: "processed_at", type: "datetime", nullable: true })
  processedAt!: Date | null;
}
```

- [ ] **Step 5: 修改 cron-job.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity } from "typeorm";

/** 计划任务记录。本地 SQLite，逻辑外键无 DB 约束。 */
@Entity("cron_jobs")
export class CronJob extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" }) cloudUserId!: string;
  @Column({ name: "session_id" }) sessionId!: string;
  @Column({ type: "varchar" }) kind!: "cron" | "once";
  @Column({ name: "cron_expr", type: "varchar", nullable: true }) cronExpr!: string | null;
  @Column({ type: "varchar", nullable: true }) timezone!: string | null;
  @Column({ name: "run_at", type: "datetime", nullable: true }) runAt!: Date | null;
  @Column({ type: "text" }) prompt!: string;
  @Column({ type: "varchar", length: 200 }) title!: string;
  @Column({ type: "boolean", default: true }) enabled!: boolean;
  @Column({ name: "last_fired_at", type: "datetime", nullable: true }) lastFiredAt!: Date | null;
  @Column({ name: "next_fire_at", type: "datetime", nullable: true }) nextFireAt!: Date | null;
  @CreateDateColumn({ name: "created_at" }) createdAt!: Date;
}
```

- [ ] **Step 6: 修改 schedule.service.ts — 删去手动 randomUUID()**

在 `apps/server-agent/src/services/schedule.service.ts` 中：

1. 删除顶部 `import { randomUUID } from "node:crypto";`
2. 在 `create()` 方法里删除 `const id = randomUUID();` 这行
3. 在 `repo.save({ ... })` 的对象里删去 `id,` 字段（`@BeforeInsert` 会自动生成）

修改后的 `create()` 方法：

```typescript
async create(input: CreateCronJobInput): Promise<CronJob> {
  const nextFireAt = ScheduleService.computeNextFireAt(input);
  const entity = await this.repo.save({
    sessionId: input.sessionId,
    title: input.title,
    prompt: input.prompt,
    kind: input.kind,
    cronExpr: input.cronExpr ?? null,
    timezone: input.timezone ?? null,
    runAt: input.runAt ? new Date(input.runAt) : null,
    enabled: true,
    lastFiredAt: null,
    nextFireAt,
  } as CronJob);
  if (entity.enabled) await this.sink?.register(entity);
  return entity;
}
```

- [ ] **Step 7: 类型检查**

```bash
pnpm --filter server-agent typecheck
```

预期：0 错误。

- [ ] **Step 8: Commit**

```bash
git add apps/server-agent/src/entities/ apps/server-agent/src/services/schedule.service.ts
git commit -m "feat(server-agent): 5 张普通 entity 主键改为 SnowflakeBaseEntity + schedule 删去手动 UUID"
```

---

### Task 3: server-agent 特殊 entity 改造 + session-message 服务适配

3 张特殊表：`cloud_identity`（原主键 = cloudUserId）、`settings`（复合主键）、`session_messages`（脱钩 LangGraph ID，增加 `langgraphId` 列）。同步更新 `session-message.service.ts` 的幂等检查逻辑。

**Files:**
- Modify: `apps/server-agent/src/entities/cloud-identity.entity.ts`
- Modify: `apps/server-agent/src/entities/setting.entity.ts`
- Modify: `apps/server-agent/src/entities/session-message.entity.ts`
- Modify: `apps/server-agent/src/services/session-message.service.ts`

**Interfaces:**
- Consumes: `SnowflakeBaseEntity` from `@meshbot/common`
- `RecordUserInput.id` / `RecordAssistantInput.id` 等接口中的 `id` 字段语义不变（仍是 LangGraph UUID），但服务层将其写入 `langgraphId` 列而非 `id` 列

- [ ] **Step 1: 修改 cloud-identity.entity.ts**

原来的 `@PrimaryColumn({ name: "cloud_user_id" })` 改为普通 `@Column` 加 `unique: true`，整个类改为继承 `SnowflakeBaseEntity`：

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

/** 云端身份镜像（v3 多行）：每个登录过的云端账号一行，cloudUserId 唯一。 */
@Entity("cloud_identity")
export class CloudIdentity extends SnowflakeBaseEntity {
  /** 原主键，现为唯一索引列，业务查询仍用此字段。 */
  @Column({ name: "cloud_user_id", type: "text", unique: true })
  cloudUserId!: string;

  @Column({ type: "text" })
  email!: string;

  @Column({ name: "display_name", type: "text" })
  displayName!: string;

  @Column({ name: "org_id", type: "text", nullable: true })
  orgId!: string | null;

  @Column({ name: "org_name", type: "text", nullable: true })
  orgName!: string | null;

  @Column({ type: "text", nullable: true })
  role!: string | null;

  @Column({ name: "cloud_token", type: "text" })
  cloudToken!: string;

  @Column({ name: "cloud_token_expires_at", type: "text", nullable: true })
  cloudTokenExpiresAt!: string | null;

  @Column({ name: "logged_in", type: "boolean", default: false })
  loggedIn!: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

- [ ] **Step 2: 修改 setting.entity.ts**

原来的复合 `@PrimaryColumn` 改为 `@Unique` 约束 + 普通列，整个类改继承基类：

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, Entity, Unique } from "typeorm";

@Entity("settings")
@Unique(["cloudUserId", "key"])
export class Setting extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column()
  key!: string;

  @Column()
  value!: string;
}
```

- [ ] **Step 3: 修改 session-message.entity.ts**

增加 `langgraphId` 列，类改继承基类：

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/**
 * 会话消息表（append-only，永不删）。
 * id = 雪花 PK；langgraphId = 原 LangGraph / checkpointer message UUID，用于三方关联查询。
 */
@Entity("session_messages")
@Index(["sessionId", "createdAt", "id"])
@Index(["sessionId", "seq"])
export class SessionMessage extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ type: "integer", default: 0 })
  seq!: number;

  @Column({ name: "session_id" })
  sessionId!: string;

  /**
   * 原 LangGraph / checkpointer message UUID（用于幂等检查和前端 pending 消息关联）。
   * 新写入行必填；历史行迁移时无需回填（数据清空重建）。
   */
  @Column({ name: "langgraph_id", type: "varchar", nullable: true })
  langgraphId!: string | null;

  @Column({ type: "varchar" })
  role!: "user" | "assistant" | "system" | "tool";

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "text", nullable: true })
  reasoning!: string | null;

  @Column({ name: "tool_calls", type: "text", nullable: true })
  toolCalls!: string | null;

  @Column({ name: "tool_call_id", type: "varchar", nullable: true })
  toolCallId!: string | null;

  @Column({ type: "text", nullable: true })
  metadata!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
```

- [ ] **Step 4: 修改 session-message.service.ts — 幂等检查改走 langgraphId**

需要修改 4 个 record* 方法（`recordUser`、`recordAssistant`、`recordToolResult`、`recordCompactionPlaceholder`）和 `existingIds` 方法：

**record* 方法的改动模式**（以 `recordUser` 为例）：

```typescript
async recordUser(input: RecordUserInput): Promise<void> {
  // 改：findOneBy({ id: input.id }) → findOneBy({ langgraphId: input.id })
  const exists = await this.repo.findOneBy({ langgraphId: input.id });
  if (exists) return;
  await this.insertWithSeq({
    // 改：id: input.id → langgraphId: input.id
    langgraphId: input.id,
    sessionId: input.sessionId,
    role: "user",
    content: input.content,
    reasoning: null,
    toolCalls: null,
    toolCallId: null,
  });
}
```

同理 `recordAssistant`：

```typescript
async recordAssistant(input: RecordAssistantInput): Promise<void> {
  const exists = await this.repo.findOneBy({ langgraphId: input.id });
  if (exists) return;
  await this.insertWithSeq({
    langgraphId: input.id,
    sessionId: input.sessionId,
    role: "assistant",
    content: input.content,
    reasoning: input.reasoning,
    toolCalls: input.toolCalls ?? null,
    toolCallId: null,
  });
}
```

`recordToolResult`：

```typescript
async recordToolResult(input: RecordToolResultInput): Promise<void> {
  const exists = await this.repo.findOneBy({ langgraphId: input.id });
  if (exists) return;
  const metadata = input.ok === false ? JSON.stringify({ ok: false }) : null;
  await this.insertWithSeq({
    langgraphId: input.id,
    sessionId: input.sessionId,
    role: "tool",
    content: input.content,
    reasoning: null,
    toolCalls: null,
    toolCallId: input.toolCallId,
    metadata,
  });
}
```

`recordCompactionPlaceholder`：

```typescript
async recordCompactionPlaceholder(
  input: RecordCompactionPlaceholderInput,
): Promise<void> {
  const exists = await this.repo.findOneBy({ langgraphId: input.id });
  if (exists) return;
  await this.insertWithSeq({
    langgraphId: input.id,
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
  });
}
```

**`existingIds` 改走 langgraphId**（前端 pending 消息用 LangGraph UUID 关联历史）：

```typescript
async existingIds(sessionId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await this.repo.find({
    where: { sessionId, langgraphId: In(ids) },
    select: { langgraphId: true },
  });
  return new Set(rows.map((r) => r.langgraphId!));
}
```

注意：`listPage`（cursor = 雪花 ID）、`findByIdOrFail`、`setFeedback`（messageId = 雪花 ID）均按雪花 `id` 查询，**不需要改**。

- [ ] **Step 5: 类型检查**

```bash
pnpm --filter server-agent typecheck
```

预期：0 错误。

- [ ] **Step 6: Commit**

```bash
git add apps/server-agent/src/entities/cloud-identity.entity.ts \
        apps/server-agent/src/entities/setting.entity.ts \
        apps/server-agent/src/entities/session-message.entity.ts \
        apps/server-agent/src/services/session-message.service.ts
git commit -m "feat(server-agent): 特殊 entity 改雪花 PK（cloud-identity 代理键、settings 唯一约束、session-message 脱钩 langgraphId）"
```

---

### Task 4: server-agent TypeORM 迁移

新增 TypeORM 迁移文件，DROP+CREATE 全部 8 张表为新 schema（VARCHAR(20) 主键）。启动时 `migrationsRun: true` 自动执行，本地 `~/.meshbot/agent.db` 需手动删除后重建。

**Files:**
- Create: `apps/server-agent/src/migrations/1780500000000-SnowflakePrimaryKeys.ts`

**Interfaces:**
- Consumes: TypeORM `MigrationInterface`，无前置依赖
- 执行完毕后 server-agent 可正常启动并写入新格式数据

- [ ] **Step 1: 创建迁移文件**

```typescript
// apps/server-agent/src/migrations/1780500000000-SnowflakePrimaryKeys.ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 所有表主键从 UUID/复合键改为雪花 VARCHAR(20)。
 * session_messages 新增 langgraph_id 列（存原 LangGraph message UUID）。
 * cloud_identity 从 cloudUserId PK 改为代理雪花 PK + cloudUserId UNIQUE。
 * settings 从复合 PK 改为代理雪花 PK + (cloudUserId, key) UNIQUE。
 * 数据可清空：up/down 均 DROP+CREATE，无 backfill。
 */
export class SnowflakePrimaryKeys1780500000000 implements MigrationInterface {
  name = "SnowflakePrimaryKeys1780500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- 1. DROP（子表先删，无 FK 约束故顺序只影响可读性）
    for (const t of [
      "session_messages",
      "llm_calls",
      "pending_messages",
      "cron_jobs",
      "sessions",
      "model_configs",
      "cloud_identity",
      "settings",
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${t}"`);
    }

    // ---- 2. CREATE
    await queryRunner.query(`
      CREATE TABLE "sessions" (
        "id"                  VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id"       TEXT,
        "title"               TEXT         NOT NULL,
        "status"              VARCHAR      NOT NULL DEFAULT 'idle',
        "pinned_at"           DATETIME,
        "title_generated"     BOOLEAN      NOT NULL DEFAULT 0,
        "kind"                VARCHAR      NOT NULL DEFAULT 'user',
        "im_conversation_id"  TEXT,
        "im_conv_type"        VARCHAR,
        "agent_enabled"       BOOLEAN      NOT NULL DEFAULT 1,
        "created_at"          DATETIME     NOT NULL DEFAULT (datetime('now')),
        "updated_at"          DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_sessions_cloud_user_id" ON "sessions" ("cloud_user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sessions_im_companion" ON "sessions" ("cloud_user_id", "im_conversation_id") WHERE "kind" = 'im'`,
    );

    await queryRunner.query(`
      CREATE TABLE "session_messages" (
        "id"           VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT        NOT NULL,
        "seq"          INTEGER      NOT NULL DEFAULT 0,
        "session_id"   VARCHAR      NOT NULL,
        "langgraph_id" VARCHAR,
        "role"         VARCHAR      NOT NULL,
        "content"      TEXT         NOT NULL,
        "reasoning"    TEXT,
        "tool_calls"   TEXT,
        "tool_call_id" VARCHAR,
        "metadata"     TEXT,
        "created_at"   DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_session_messages_session_created_id" ON "session_messages" ("session_id", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_session_messages_session_seq" ON "session_messages" ("session_id", "seq")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_session_messages_cloud_user_id" ON "session_messages" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "llm_calls" (
        "id"                    VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id"         TEXT,
        "session_id"            VARCHAR      NOT NULL,
        "message_id"            VARCHAR      NOT NULL,
        "provider_type"         VARCHAR      NOT NULL,
        "model"                 VARCHAR      NOT NULL,
        "input_tokens"          INTEGER      NOT NULL DEFAULT 0,
        "output_tokens"         INTEGER      NOT NULL DEFAULT 0,
        "total_tokens"          INTEGER      NOT NULL DEFAULT 0,
        "cache_read_tokens"     INTEGER      NOT NULL DEFAULT 0,
        "cache_creation_tokens" INTEGER      NOT NULL DEFAULT 0,
        "reasoning_tokens"      INTEGER      NOT NULL DEFAULT 0,
        "duration_ms"           INTEGER      NOT NULL DEFAULT 0,
        "created_at"            DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_llm_calls_cloud_user_id" ON "llm_calls" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "model_configs" (
        "id"             VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id"  TEXT,
        "provider_type"  VARCHAR      NOT NULL,
        "name"           VARCHAR      NOT NULL,
        "model"          VARCHAR      NOT NULL,
        "api_key"        VARCHAR      NOT NULL,
        "base_url"       VARCHAR      NOT NULL DEFAULT '',
        "enabled"        BOOLEAN      NOT NULL DEFAULT 1,
        "context_window" INTEGER      NOT NULL DEFAULT 128000,
        "created_at"     DATETIME     NOT NULL DEFAULT (datetime('now')),
        "updated_at"     DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_model_configs_cloud_user_id" ON "model_configs" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "pending_messages" (
        "id"           VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT,
        "session_id"   VARCHAR      NOT NULL,
        "content"      TEXT         NOT NULL,
        "status"       VARCHAR      NOT NULL DEFAULT 'pending',
        "created_at"   DATETIME     NOT NULL DEFAULT (datetime('now')),
        "processed_at" DATETIME
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_pending_messages_cloud_user_id" ON "pending_messages" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "cron_jobs" (
        "id"           VARCHAR(20)   PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT         NOT NULL,
        "session_id"   VARCHAR       NOT NULL,
        "kind"         VARCHAR       NOT NULL,
        "cron_expr"    VARCHAR,
        "timezone"     VARCHAR,
        "run_at"       DATETIME,
        "prompt"       TEXT          NOT NULL,
        "title"        VARCHAR(200)  NOT NULL,
        "enabled"      BOOLEAN       NOT NULL DEFAULT 1,
        "last_fired_at" DATETIME,
        "next_fire_at"  DATETIME,
        "created_at"   DATETIME      NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_cron_jobs_cloud_user_id" ON "cron_jobs" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "cloud_identity" (
        "id"                    VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id"         TEXT         NOT NULL UNIQUE,
        "email"                 TEXT         NOT NULL,
        "display_name"          TEXT         NOT NULL,
        "org_id"                TEXT,
        "org_name"              TEXT,
        "role"                  TEXT,
        "cloud_token"           TEXT         NOT NULL,
        "cloud_token_expires_at" TEXT,
        "logged_in"             BOOLEAN      NOT NULL DEFAULT 0,
        "created_at"            DATETIME     NOT NULL DEFAULT (datetime('now')),
        "updated_at"            DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "settings" (
        "id"           VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT        NOT NULL,
        "key"          TEXT         NOT NULL,
        "value"        TEXT         NOT NULL,
        UNIQUE ("cloud_user_id", "key")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const t of [
      "session_messages",
      "llm_calls",
      "pending_messages",
      "cron_jobs",
      "sessions",
      "model_configs",
      "cloud_identity",
      "settings",
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${t}"`);
    }

    // 恢复旧 UUID schema（数据丢失可接受）
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "title" TEXT NOT NULL, "status" VARCHAR NOT NULL DEFAULT 'idle', "pinned_at" DATETIME, "title_generated" BOOLEAN NOT NULL DEFAULT 0, "kind" VARCHAR NOT NULL DEFAULT 'user', "im_conversation_id" TEXT, "im_conv_type" VARCHAR, "agent_enabled" BOOLEAN NOT NULL DEFAULT 1, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')), "updated_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "session_messages" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT NOT NULL, "seq" INTEGER NOT NULL DEFAULT 0, "session_id" VARCHAR NOT NULL, "role" VARCHAR NOT NULL, "content" TEXT NOT NULL, "reasoning" TEXT, "tool_calls" TEXT, "tool_call_id" VARCHAR, "metadata" TEXT, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "llm_calls" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "session_id" VARCHAR NOT NULL, "message_id" VARCHAR NOT NULL, "provider_type" VARCHAR NOT NULL, "model" VARCHAR NOT NULL, "input_tokens" INTEGER NOT NULL DEFAULT 0, "output_tokens" INTEGER NOT NULL DEFAULT 0, "total_tokens" INTEGER NOT NULL DEFAULT 0, "cache_read_tokens" INTEGER NOT NULL DEFAULT 0, "cache_creation_tokens" INTEGER NOT NULL DEFAULT 0, "reasoning_tokens" INTEGER NOT NULL DEFAULT 0, "duration_ms" INTEGER NOT NULL DEFAULT 0, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "model_configs" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "provider_type" VARCHAR NOT NULL, "name" VARCHAR NOT NULL, "model" VARCHAR NOT NULL, "api_key" VARCHAR NOT NULL, "base_url" VARCHAR NOT NULL DEFAULT '', "enabled" BOOLEAN NOT NULL DEFAULT 1, "context_window" INTEGER NOT NULL DEFAULT 128000, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')), "updated_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "pending_messages" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "session_id" VARCHAR NOT NULL, "content" TEXT NOT NULL, "status" VARCHAR NOT NULL DEFAULT 'pending', "created_at" DATETIME NOT NULL DEFAULT (datetime('now')), "processed_at" DATETIME)`,
    );
    await queryRunner.query(
      `CREATE TABLE "cron_jobs" ("id" VARCHAR PRIMARY KEY NOT NULL, "cloud_user_id" TEXT NOT NULL, "session_id" VARCHAR NOT NULL, "kind" VARCHAR NOT NULL, "cron_expr" VARCHAR, "timezone" VARCHAR, "run_at" DATETIME, "prompt" TEXT NOT NULL, "title" VARCHAR(200) NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT 1, "last_fired_at" DATETIME, "next_fire_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "cloud_identity" ("cloud_user_id" TEXT PRIMARY KEY NOT NULL, "email" TEXT NOT NULL, "display_name" TEXT NOT NULL, "org_id" TEXT, "org_name" TEXT, "role" TEXT, "cloud_token" TEXT NOT NULL, "cloud_token_expires_at" TEXT, "logged_in" BOOLEAN NOT NULL DEFAULT 0, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')), "updated_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "settings" ("cloud_user_id" TEXT NOT NULL, "key" TEXT NOT NULL, "value" TEXT NOT NULL, PRIMARY KEY ("cloud_user_id", "key"))`,
    );
  }
}
```

- [ ] **Step 2: 删除本地开发库并启动验证**

```bash
rm -f ~/.meshbot/agent.db
pnpm dev:server-agent
```

预期：服务启动日志显示 `Migration SnowflakePrimaryKeys1780500000000 executed`，无报错。

- [ ] **Step 3: 冒烟测试 — 确认雪花 ID 写入**

启动后用 API 或 e2e 创建一个 model-config 或 session，确认返回的 `id` 是 19-20 位纯数字字符串而非 UUID。

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/migrations/1780500000000-SnowflakePrimaryKeys.ts
git commit -m "feat(server-agent): TypeORM 迁移 — 全部 8 张表主键改为雪花 VARCHAR(20)"
```

---

### Task 5: libs/main entity 改造 + server-main DDL

7 个 server-main entity 全部继承 `SnowflakeBaseEntity`，FK 列类型从 `{ type: "uuid" }` 改为 `{ type: "varchar", length: 20 }`。新增 DDL SQL 文件供 DBA 执行。

**Files:**
- Modify: `libs/main/src/entities/app-user.entity.ts`
- Modify: `libs/main/src/entities/organization.entity.ts`
- Modify: `libs/main/src/entities/membership.entity.ts`
- Modify: `libs/main/src/entities/invitation.entity.ts`
- Modify: `libs/main/src/entities/conversation.entity.ts`
- Modify: `libs/main/src/entities/conversation-member.entity.ts`
- Modify: `libs/main/src/entities/message.entity.ts`
- Create: `apps/server-main/migrations/202606181200-snowflake-primary-keys.sql`

**Interfaces:**
- Consumes: `SnowflakeBaseEntity` from `@meshbot/common`
- Produces: 7 个 entity，所有 `type: "uuid"` FK 列改为 `type: "varchar", length: 20`

- [ ] **Step 1: 修改 app-user.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index, UpdateDateColumn } from "typeorm";

/** 云端用户。云端轨独立账号体系（与 server-agent 单机用户不共享）。 */
@Entity("app_user")
@Index("idx_app_user_email", ["email"], { unique: true })
export class AppUser extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 255 })
  passwordHash!: string;

  @Column({ type: "varchar", length: 64 })
  displayName!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  activeOrgId!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
```

- [ ] **Step 2: 修改 organization.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

/** 企业/组织（单层）。ownerId 与 Membership.role=owner 冗余，便于直查。 */
@Entity("organization")
export class Organization extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 64 })
  name!: string;

  @Column({ type: "varchar", length: 20 })
  ownerId!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
```

- [ ] **Step 3: 修改 membership.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 用户↔组织 多对多成员关系。唯一索引 (org_id, user_id)。 */
@Entity("membership")
@Index("idx_membership_org_user", ["orgId", "userId"], { unique: true })
@Index("idx_membership_user", ["userId"])
export class Membership extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  orgId!: string;

  @Column({ type: "varchar", length: 20 })
  userId!: string;

  @Column({ type: "varchar", length: 16 })
  role!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
```

- [ ] **Step 4: 修改 invitation.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 组织邀请。token 即邮件邀请码。 */
@Entity("invitation")
@Index("idx_invitation_token", ["token"], { unique: true })
@Index("idx_invitation_org_email_pending", ["orgId", "email"], {
  unique: true,
  where: "status = 'pending'",
})
export class Invitation extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  orgId!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 64 })
  token!: string;

  @Column({ type: "varchar", length: 16, default: "pending" })
  status!: string;

  @Column({ type: "varchar", length: 20 })
  invitedBy!: string;

  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  @Column({ type: "varchar", length: 20, nullable: true })
  acceptedBy!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  acceptedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
```

- [ ] **Step 5: 修改 conversation.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 会话（频道或 DM）。type='channel' 时 name 非空；type='dm' 时 dmKey 非空。 */
@Entity("conversation")
@Index("idx_conversation_org_type", ["orgId", "type"])
export class Conversation extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  orgId!: string;

  @Column({ type: "varchar", length: 16 })
  type!: string;

  @Column({ type: "varchar", length: 64, nullable: true })
  name!: string | null;

  @Column({ type: "varchar", length: 80, nullable: true })
  dmKey!: string | null;

  @Column({ type: "varchar", length: 20 })
  createdBy!: string;

  @Column({ type: "varchar", length: 16, default: "public" })
  visibility!: "public" | "private";

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
```

- [ ] **Step 6: 修改 conversation-member.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 会话成员关系。唯一索引 (conversation_id, user_id)。 */
@Entity("conversation_member")
@Index("idx_conversation_member_conv_user", ["conversationId", "userId"], {
  unique: true,
})
export class ConversationMember extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  conversationId!: string;

  @Column({ type: "varchar", length: 20 })
  userId!: string;

  @Column({ type: "timestamptz", nullable: true })
  lastReadAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  joinedAt!: Date;
}
```

- [ ] **Step 7: 修改 message.entity.ts**

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 会话消息。索引 (conversation_id, created_at) 支持按时间分页查询。 */
@Entity("message")
@Index("idx_message_conv_created_at", ["conversationId", "createdAt"])
export class Message extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  conversationId!: string;

  @Column({ type: "varchar", length: 20 })
  senderId!: string;

  @Column({ type: "text" })
  content!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
```

- [ ] **Step 8: 创建 server-main DDL 文件**

```sql
-- =============================================================================
-- meshbot server-main 雪花主键迁移（所有表 UUID PK → VARCHAR(20) 雪花 ID）
--
-- 执行方式：DBA 手动执行（psql -f 202606181200-snowflake-primary-keys.sql）
-- 注意：此文件 DROP + CREATE，会清空所有数据。执行前确认无生产数据。
-- 执行后应用层由 SnowflakeBaseEntity @BeforeInsert 负责生成雪花 ID。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- DROP（子表先删，虽无 FK 约束，顺序保持可读）
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "message";
DROP TABLE IF EXISTS "conversation_member";
DROP TABLE IF EXISTS "conversation";
DROP TABLE IF EXISTS "invitation";
DROP TABLE IF EXISTS "membership";
DROP TABLE IF EXISTS "organization";
DROP TABLE IF EXISTS "app_user";

-- ---------------------------------------------------------------------------
-- app_user
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "app_user" (
  "id"            varchar(20)  NOT NULL,
  "email"         varchar(255) NOT NULL,
  "password_hash" varchar(255) NOT NULL,
  "display_name"  varchar(64)  NOT NULL,
  "active_org_id" varchar(20),
  "created_at"    timestamptz  NOT NULL DEFAULT now(),
  "updated_at"    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_app_user" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_user_email" ON "app_user" ("email");

-- ---------------------------------------------------------------------------
-- organization
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "organization" (
  "id"         varchar(20) NOT NULL,
  "name"       varchar(64) NOT NULL,
  "owner_id"   varchar(20) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_organization" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- membership
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "membership" (
  "id"         varchar(20) NOT NULL,
  "org_id"     varchar(20) NOT NULL,
  "user_id"    varchar(20) NOT NULL,
  "role"       varchar(16) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_membership" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_membership_org_user" ON "membership" ("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_membership_user" ON "membership" ("user_id");

-- ---------------------------------------------------------------------------
-- invitation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "invitation" (
  "id"          varchar(20)  NOT NULL,
  "org_id"      varchar(20)  NOT NULL,
  "email"       varchar(255) NOT NULL,
  "token"       varchar(64)  NOT NULL,
  "status"      varchar(16)  NOT NULL DEFAULT 'pending',
  "invited_by"  varchar(20)  NOT NULL,
  "expires_at"  timestamptz  NOT NULL,
  "accepted_by" varchar(20),
  "accepted_at" timestamptz,
  "created_at"  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_invitation" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_token" ON "invitation" ("token");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_org_email_pending"
  ON "invitation" ("org_id", "email") WHERE "status" = 'pending';

-- ---------------------------------------------------------------------------
-- conversation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "conversation" (
  "id"         varchar(20) NOT NULL,
  "org_id"     varchar(20) NOT NULL,
  "type"       varchar(16) NOT NULL,
  "name"       varchar(64),
  "dm_key"     varchar(80),
  "created_by" varchar(20) NOT NULL,
  "visibility" varchar(16) NOT NULL DEFAULT 'public',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_conversation" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_conversation_org_type" ON "conversation" ("org_id", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_conversation_org_dm_key"
  ON "conversation" ("org_id", "dm_key") WHERE "type" = 'dm';

-- ---------------------------------------------------------------------------
-- conversation_member
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "conversation_member" (
  "id"              varchar(20) NOT NULL,
  "conversation_id" varchar(20) NOT NULL,
  "user_id"         varchar(20) NOT NULL,
  "last_read_at"    timestamptz,
  "joined_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_conversation_member" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_conversation_member_conv_user"
  ON "conversation_member" ("conversation_id", "user_id");

-- ---------------------------------------------------------------------------
-- message
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "message" (
  "id"              varchar(20) NOT NULL,
  "conversation_id" varchar(20) NOT NULL,
  "sender_id"       varchar(20) NOT NULL,
  "content"         text        NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_message" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_message_conv_created_at" ON "message" ("conversation_id", "created_at");
```

- [ ] **Step 9: 类型检查**

```bash
pnpm --filter @meshbot/main typecheck
pnpm --filter server-main typecheck
```

预期：0 错误。

- [ ] **Step 10: Commit**

```bash
git add libs/main/src/entities/ apps/server-main/migrations/202606181200-snowflake-primary-keys.sql
git commit -m "feat(server-main): 7 张表 entity 主键改为 SnowflakeBaseEntity + DDL 迁移文件"
```

---

### Task 6: check:pk 围栏脚本 + 单测 + package.json

**Files:**
- Create: `scripts/check-pk.ts`
- Create: `scripts/check-pk.spec.ts`
- Modify: `package.json`（根）

**Interfaces:**
- Produces: `runPkCheck(files: Record<string, string>): PkViolation[]` — 供单测调用
- `PkViolation = { file: string; className: string; reason: string }`

- [ ] **Step 1: 创建 check-pk.ts**

```typescript
#!/usr/bin/env tsx
/**
 * check-pk: 确保所有 @Entity 类都继承自 SnowflakeBaseEntity。
 *
 * 检查 2 类问题：
 *   A. MISSING_BASE     — @Entity 类未继承 SnowflakeBaseEntity
 *   B. LEGACY_PRIMARY   — 残留 @PrimaryGeneratedColumn 或裸 @PrimaryColumn（非基类文件）
 *
 * 用法：
 *   pnpm check:pk                  扫描全仓
 *   pnpm check:pk -- --strict      发现违规时 exit 1（CI 用）
 */
import * as path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { collectTsFiles } from "./lib/ts-files";

const ROOT = path.resolve(__dirname, "..");

export interface PkViolation {
  file: string;
  className: string;
  reason: string;
}

/** 核心检查逻辑；接受 { filePath: fileContent } map，便于单测注入虚拟内容。 */
export function runPkCheck(files: Record<string, string>): PkViolation[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [fp, src] of Object.entries(files)) {
    project.createSourceFile(fp, src, { overwrite: true });
  }

  const violations: PkViolation[] = [];

  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (fp.endsWith("snowflake-base.entity.ts")) continue;
    if (!fp.endsWith(".entity.ts")) continue;

    for (const cls of sf.getClasses()) {
      const decorators = cls.getDecorators().map((d) => d.getName());
      if (!decorators.includes("Entity")) continue;

      const className = cls.getName() ?? "<anonymous>";

      // A. 未继承 SnowflakeBaseEntity
      const extendsSnowflake = cls
        .getExtends()
        ?.getExpression()
        .getText()
        .includes("SnowflakeBaseEntity");
      if (!extendsSnowflake) {
        violations.push({
          file: fp,
          className,
          reason: "缺少 extends SnowflakeBaseEntity",
        });
      }

      // B. 残留 @PrimaryGeneratedColumn 或裸 @PrimaryColumn
      for (const prop of cls.getProperties()) {
        const propDecorators = prop.getDecorators().map((d) => d.getName());
        if (propDecorators.includes("PrimaryGeneratedColumn")) {
          violations.push({
            file: fp,
            className,
            reason: `属性 ${prop.getName()} 残留 @PrimaryGeneratedColumn（应继承 SnowflakeBaseEntity）`,
          });
        }
        if (propDecorators.includes("PrimaryColumn")) {
          violations.push({
            file: fp,
            className,
            reason: `属性 ${prop.getName()} 残留裸 @PrimaryColumn（应继承 SnowflakeBaseEntity）`,
          });
        }
      }
    }
  }

  return violations;
}

// ---- CLI 入口
const isStrict = process.argv.includes("--strict");

const entityFiles = collectTsFiles(ROOT, { pruneDirs: ["__tests__"] }).filter(
  (f) => f.endsWith(".entity.ts"),
);

import * as fs from "node:fs";
const fileMap: Record<string, string> = {};
for (const f of entityFiles) {
  fileMap[f] = fs.readFileSync(f, "utf-8");
}

const violations = runPkCheck(fileMap);

if (violations.length === 0) {
  console.log("[check:pk] OK — 全部 entity 均继承 SnowflakeBaseEntity");
  process.exit(0);
}

for (const v of violations) {
  const rel = path.relative(ROOT, v.file);
  console.error(`[check:pk] FAIL: ${rel} — ${v.className}: ${v.reason}`);
}

if (isStrict) process.exit(1);
```

- [ ] **Step 2: 创建 check-pk.spec.ts**

```typescript
// scripts/check-pk.spec.ts
import { runPkCheck } from "./check-pk";

const SNOWFLAKE_BASE = `
  import { BeforeInsert, PrimaryColumn } from "typeorm";
  import { generateSnowflakeId } from "../utils/snowflake";
  export abstract class SnowflakeBaseEntity {
    @PrimaryColumn({ type: "varchar", length: 20 }) id!: string;
    @BeforeInsert() protected generateId() { if (!this.id) this.id = generateSnowflakeId(); }
  }
`;

const GOOD_ENTITY = `
  import { SnowflakeBaseEntity } from "@meshbot/common";
  import { Column, Entity } from "typeorm";
  @Entity("sessions")
  export class Session extends SnowflakeBaseEntity {
    @Column() title!: string;
  }
`;

const UUID_ENTITY = `
  import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
  @Entity("sessions")
  export class Session {
    @PrimaryGeneratedColumn("uuid") id!: string;
    @Column() title!: string;
  }
`;

const MISSING_EXTENDS = `
  import { Column, Entity } from "typeorm";
  @Entity("sessions")
  export class Session {
    @Column() title!: string;
  }
`;

const BARE_PRIMARY_COLUMN = `
  import { Column, Entity, PrimaryColumn } from "typeorm";
  @Entity("sessions")
  export class Session {
    @PrimaryColumn() id!: string;
    @Column() title!: string;
  }
`;

describe("runPkCheck", () => {
  it("合规 entity → 无违规", () => {
    const v = runPkCheck({
      "snowflake-base.entity.ts": SNOWFLAKE_BASE,
      "session.entity.ts": GOOD_ENTITY,
    });
    expect(v).toHaveLength(0);
  });

  it("snowflake-base.entity.ts 自身被跳过", () => {
    const v = runPkCheck({ "snowflake-base.entity.ts": SNOWFLAKE_BASE });
    expect(v).toHaveLength(0);
  });

  it("@PrimaryGeneratedColumn → LEGACY_PRIMARY 违规", () => {
    const v = runPkCheck({ "session.entity.ts": UUID_ENTITY });
    expect(v.some((x) => x.reason.includes("PrimaryGeneratedColumn"))).toBe(true);
  });

  it("缺少 extends SnowflakeBaseEntity → MISSING_BASE 违规", () => {
    const v = runPkCheck({ "session.entity.ts": MISSING_EXTENDS });
    expect(v.some((x) => x.reason.includes("缺少 extends SnowflakeBaseEntity"))).toBe(true);
  });

  it("裸 @PrimaryColumn → LEGACY_PRIMARY 违规", () => {
    const v = runPkCheck({ "session.entity.ts": BARE_PRIMARY_COLUMN });
    expect(v.some((x) => x.reason.includes("@PrimaryColumn"))).toBe(true);
  });

  it("非 .entity.ts 文件被跳过", () => {
    const v = runPkCheck({
      "session.service.ts": `@Entity("sessions") export class Session { @PrimaryGeneratedColumn("uuid") id!: string; }`,
    });
    expect(v).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 运行单测验证**

```bash
pnpm test scripts/check-pk.spec.ts
```

预期：6 个测试全部通过。

- [ ] **Step 4: 修改根 package.json**

在根 `package.json` 中：

1. 追加 script：
```json
"check:pk": "tsx scripts/check-pk.ts",
```

2. 在 `check` 末尾追加 `&& pnpm check:pk`：
```json
"check": "pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo && pnpm check:scope && pnpm check:dead && pnpm check:error-code && pnpm check:pk",
```

3. 在 `check:strict` 末尾追加 `&& pnpm check:pk -- --strict`：
```json
"check:strict": "pnpm check:tx -- --strict && pnpm check:naming -- --strict && pnpm check:lock-tx -- --strict && pnpm check:repo -- --strict && pnpm check:scope -- --strict && pnpm check:dead -- --strict && pnpm check:error-code -- --strict && pnpm check:pk -- --strict",
```

4. 在 `check:parallel` 的正则中追加 `pk`：
```json
"check:parallel": "pnpm run \"/^check:(tx|naming|lock-tx|repo|scope|dead|error-code|pk)$/\"",
```

- [ ] **Step 5: 跑全量围栏验证**

```bash
pnpm check:pk
```

预期：`[check:pk] OK — 全部 entity 均继承 SnowflakeBaseEntity`

```bash
pnpm check
```

预期：全部检查通过，exit 0。

- [ ] **Step 6: Commit**

```bash
git add scripts/check-pk.ts scripts/check-pk.spec.ts package.json
git commit -m "feat(scripts): check:pk 围栏 — 确保所有 @Entity 类继承 SnowflakeBaseEntity"
```
