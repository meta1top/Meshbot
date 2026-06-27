# 彻底删除 IM 伴生 Agent（companion）功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从代码、DB schema、数据三层彻底删除「IM 伴生 Agent」（频道/私聊 agent 自动代答）功能。

**Architecture:** 整删伴生专属文件（service/trigger/controller/dto + 前端死代码）；从 `SessionService` / `im.module` / `Session` entity / `libs/types` 移除伴生方法与字段；新建迁移 `1780600000000` 删索引/列/已有 `kind='im'` 数据（迁移不可变 → 不改旧迁移）。保留 relay/EventsGateway/IM 浏览。

**Tech Stack:** NestJS（server-agent）+ TypeORM + better-sqlite3（SQLite 3.53，支持 `DROP COLUMN`）/ Next.js + Jotai（web-agent）/ jest。

## Global Constraints

- **迁移不可变**：不改 `1780500000000-SnowflakePrimaryKeys.ts`，**新建** `1780600000000-DropSessionImCompanionFields.ts`。
- **SQLite 删列前先删引用该列的索引**（`uq_sessions_im_companion` 引用 `im_conversation_id`）。
- **保留（不能删）**：`ImRelayClientService` 的 `IM_WS_EVENTS.message` 订阅/emit、`EventsGateway.onMessage`（下行浏览器）、`CloudImService`/`CloudImController`/`SidebarController`/`SidebarService`/`EventsGateway`、`kind` 的 `user`/`quick`、`listAllSorted` 的 `kind='user'` 过滤。
- **checkpointer（每账号独立库）伴生 thread 的孤儿数据**：迁移够不到，留着（不引入运行时清理）。
- 中文注释/提交（conventional commits）；commit 前 `pnpm check`；不在 `if` 前一行放注释。

---

## File Structure

**整删（server-agent）**：`services/im-agent.service.ts`(+`.spec.ts`)、`services/im-agent.trigger.ts`(+`.spec.ts`)、`controllers/im-agent.controller.ts`、`dto/im-agent.dto.ts`。
**整删（web-agent）**：`src/rest/im-agent.ts`、`src/components/im/agent-toggle.tsx`（均零导入死代码）。
**改**：`services/session.service.ts`(+`.spec.ts`)、`entities/session.entity.ts`、`im.module.ts`、`libs/types/src/im/im.schema.ts`(+`index.ts`)、web-agent `hooks/use-session-stream.ts`、`messages/{en,zh}.json`。
**新建**：`migrations/1780600000000-DropSessionImCompanionFields.ts`(+`migrations/__tests__/drop-session-im-companion.spec.ts`)。

---

## Task 1: 删除后端伴生代码层

**Files:**
- Delete: `apps/server-agent/src/services/im-agent.service.ts`, `apps/server-agent/src/services/im-agent.service.spec.ts`, `apps/server-agent/src/services/im-agent.trigger.ts`, `apps/server-agent/src/services/im-agent.trigger.spec.ts`, `apps/server-agent/src/controllers/im-agent.controller.ts`, `apps/server-agent/src/dto/im-agent.dto.ts`
- Modify: `apps/server-agent/src/im.module.ts`, `apps/server-agent/src/services/session.service.ts`, `apps/server-agent/src/services/session.service.spec.ts`, `libs/types/src/im/im.schema.ts`, `libs/types/src/index.ts`

**Interfaces:**
- Produces: 删除后 `SessionService` 不再有 `findOrCreateImCompanion`/`getImCompanion`/`setCompanionAgentEnabled`；`im.module` 不再注册 `ImAgentService`/`ImAgentController`；`libs/types` 不再导出 `SetAgentEnabledSchema`/`SetAgentEnabledInput`。

- [ ] **Step 1: 删 6 个伴生专属文件**

```bash
cd /Users/grant/Meta1/meshbot
git rm apps/server-agent/src/services/im-agent.service.ts \
       apps/server-agent/src/services/im-agent.service.spec.ts \
       apps/server-agent/src/services/im-agent.trigger.ts \
       apps/server-agent/src/services/im-agent.trigger.spec.ts \
       apps/server-agent/src/controllers/im-agent.controller.ts \
       apps/server-agent/src/dto/im-agent.dto.ts
```

- [ ] **Step 2: 改 `im.module.ts` —— 移除 ImAgentService/ImAgentController**

把 `apps/server-agent/src/im.module.ts` 改为（删 `ImAgentController`、`ImAgentService` 的 import 与注册；更新文件头注释去掉伴生措辞）：

```ts
import { Module } from "@nestjs/common";

import { CloudImController } from "./controllers/cloud-im.controller";
import { SidebarController } from "./controllers/sidebar.controller";
import { AuthModule } from "./auth.module";
import { SessionModule } from "./session.module";
import { CloudImService } from "./services/cloud-im.service";
import { SidebarService } from "./services/sidebar.service";
import { EventsGateway } from "./ws/events.gateway";

/**
 * IM 模块：注册 EventsGateway（本地事件总线 WS 网关）、CloudImService（REST 代理编排）、
 * CloudImController / SidebarController（薄控制器）。
 *
 * ImRelayClientService 由 AuthModule 提供并导出（OnModuleInit 启动即连）；
 * 此处 import AuthModule 即可复用。SessionModule 提供 SessionService 等。
 */
@Module({
  imports: [AuthModule, SessionModule],
  controllers: [CloudImController, SidebarController],
  providers: [CloudImService, EventsGateway, SidebarService],
  exports: [CloudImService],
})
export class ImModule {}
```

- [ ] **Step 3: 改 `session.service.ts` —— 删三个伴生方法 + 变 unused 的 `isUniqueViolation`**

在 `apps/server-agent/src/services/session.service.ts`：
1. 删除整段 `findOrCreateImCompanion`（约 347-380 行，含其上方 JSDoc）、`getImCompanion`（382-388）、`setCompanionAgentEnabled`（390-399）。
2. 删除模块级 helper `isUniqueViolation`（约第 30 行 `function isUniqueViolation(err: unknown): boolean { … }` 整个函数）——它仅被刚删的 `findOrCreateImCompanion` 使用，删后变 unused。先 `rg -n "isUniqueViolation" apps/server-agent/src/services/session.service.ts` 确认删方法后只剩定义那一处，再删定义。
3. `listAllSorted` 的 `.andWhere("s.kind = :kind", { kind: "user" })` **保留不动**。

- [ ] **Step 4: 改 `session.service.spec.ts` —— 删「IM 伴生会话」describe 块**

在 `apps/server-agent/src/services/session.service.spec.ts` 删除整个 `describe("IM 伴生会话", () => { … })` 块（从约第 609 行起到其闭合 `});`）——块内全部用例都调用已删的伴生方法。用编辑器定位该 describe 的起止大括号整体删除。

- [ ] **Step 5: 改 `libs/types` —— 删伴生专属 schema**

1. `rg -rn "SetAgentEnabledSchema|SetAgentEnabledInput" libs apps -g '*.ts' -g '*.tsx'` 确认删 Task1 上述文件后，引用仅剩 `libs/types` 自身的定义与导出。
2. 在 `libs/types/src/im/im.schema.ts` 删除 `export const SetAgentEnabledSchema = z.object({ enabled: z.boolean() });` 与 `export type SetAgentEnabledInput = z.infer<typeof SetAgentEnabledSchema>;`。
3. 在 `libs/types/src/index.ts` 删除对 `SetAgentEnabledSchema` / `SetAgentEnabledInput` 的导出项（若是 `export *` 则无需改；若具名导出则删该名）。

- [ ] **Step 6: typecheck + jest 验证**

Run: `pnpm turbo typecheck --filter=@meshbot/server-agent --filter=@meshbot/types`
Expected: 全绿（无 unused import、无对已删符号的引用）。

Run: `pnpm test -- apps/server-agent/src/services/session.service.spec.ts`
Expected: PASS（伴生用例已删；其余用例绿）。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor(server-agent): 删除 IM 伴生 Agent 编排代码（service/trigger/controller/dto + session 方法 + 注册）"
```

---

## Task 2: 删 Session 伴生字段 + 删除迁移（TDD）

**Files:**
- Modify: `apps/server-agent/src/entities/session.entity.ts`
- Create: `apps/server-agent/src/migrations/1780600000000-DropSessionImCompanionFields.ts`
- Test: `apps/server-agent/src/migrations/__tests__/drop-session-im-companion.spec.ts`

**Interfaces:**
- Consumes: Task 1 已删伴生方法（entity 字段此时无人读写）。
- Produces: 迁移类 `DropSessionImCompanionFields1780600000000`；`Session` entity 仅剩 `user|quick` 字段集。

- [ ] **Step 1: 写迁移单测（先失败）**

创建 `apps/server-agent/src/migrations/__tests__/drop-session-im-companion.spec.ts`：

```ts
import { DataSource } from "typeorm";
import { DropSessionImCompanionFields1780600000000 } from "../1780600000000-DropSessionImCompanionFields";

describe("DropSessionImCompanionFields 迁移", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: "better-sqlite3", database: ":memory:" });
    await ds.initialize();
    await ds.query(
      `CREATE TABLE "sessions" ("id" TEXT PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "title" TEXT NOT NULL, "kind" VARCHAR NOT NULL DEFAULT 'user', "im_conversation_id" TEXT, "im_conv_type" VARCHAR, "agent_enabled" BOOLEAN NOT NULL DEFAULT 1)`,
    );
    await ds.query(
      `CREATE UNIQUE INDEX "uq_sessions_im_companion" ON "sessions" ("cloud_user_id", "im_conversation_id") WHERE "kind" = 'im'`,
    );
    await ds.query(
      `CREATE TABLE "session_messages" ("id" TEXT PRIMARY KEY NOT NULL, "session_id" TEXT NOT NULL)`,
    );
    await ds.query(
      `CREATE TABLE "pending_messages" ("id" TEXT PRIMARY KEY NOT NULL, "session_id" TEXT NOT NULL)`,
    );
    await ds.query(
      `CREATE TABLE "llm_calls" ("id" TEXT PRIMARY KEY NOT NULL, "session_id" TEXT NOT NULL)`,
    );
    await ds.query(
      `INSERT INTO "sessions" ("id","cloud_user_id","title","kind","im_conversation_id","im_conv_type") VALUES ('im1','u1','c','im','conv1','dm')`,
    );
    await ds.query(
      `INSERT INTO "sessions" ("id","cloud_user_id","title","kind") VALUES ('u-s','u1','普通','user')`,
    );
    await ds.query(
      `INSERT INTO "session_messages" ("id","session_id") VALUES ('m1','im1')`,
    );
    await ds.query(
      `INSERT INTO "pending_messages" ("id","session_id") VALUES ('p1','im1')`,
    );
    await ds.query(
      `INSERT INTO "llm_calls" ("id","session_id") VALUES ('l1','im1')`,
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("up：删伴生列+索引，清 kind='im' 会话及关联，普通会话保留", async () => {
    const qr = ds.createQueryRunner();
    await new DropSessionImCompanionFields1780600000000().up(qr);
    await qr.release();

    const cols = (
      (await ds.query(`PRAGMA table_info("sessions")`)) as { name: string }[]
    ).map((r) => r.name);
    expect(cols).not.toContain("im_conversation_id");
    expect(cols).not.toContain("im_conv_type");
    expect(cols).not.toContain("agent_enabled");

    const idx = await ds.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='uq_sessions_im_companion'`,
    );
    expect(idx).toEqual([]);

    expect(await ds.query(`SELECT id FROM "sessions" ORDER BY id`)).toEqual([
      { id: "u-s" },
    ]);
    expect(await ds.query(`SELECT id FROM "session_messages"`)).toEqual([]);
    expect(await ds.query(`SELECT id FROM "pending_messages"`)).toEqual([]);
    expect(await ds.query(`SELECT id FROM "llm_calls"`)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- apps/server-agent/src/migrations/__tests__/drop-session-im-companion.spec.ts`
Expected: FAIL —— 迁移模块 `1780600000000-DropSessionImCompanionFields` 不存在。

- [ ] **Step 3: 写迁移**

创建 `apps/server-agent/src/migrations/1780600000000-DropSessionImCompanionFields.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 删除「IM 伴生 Agent」功能的 schema 与数据：
 * 删唯一索引 → 清 kind='im' 伴生会话及其关联（session_messages/pending_messages/llm_calls）
 * → 删伴生列（agent_enabled / im_conv_type / im_conversation_id）。
 * 与删除伴生功能代码（im-agent.* + Session 伴生字段）配套。SQLite 3.35+ 支持 DROP COLUMN。
 */
export class DropSessionImCompanionFields1780600000000
  implements MigrationInterface
{
  name = "DropSessionImCompanionFields1780600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_sessions_im_companion"`);

    for (const t of ["session_messages", "pending_messages", "llm_calls"]) {
      await queryRunner.query(
        `DELETE FROM "${t}" WHERE "session_id" IN (SELECT "id" FROM "sessions" WHERE "kind" = 'im')`,
      );
    }
    await queryRunner.query(`DELETE FROM "sessions" WHERE "kind" = 'im'`);

    for (const c of ["agent_enabled", "im_conv_type", "im_conversation_id"]) {
      await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "${c}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "im_conversation_id" TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "im_conv_type" VARCHAR`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "agent_enabled" BOOLEAN NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sessions_im_companion" ON "sessions" ("cloud_user_id", "im_conversation_id") WHERE "kind" = 'im'`,
    );
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- apps/server-agent/src/migrations/__tests__/drop-session-im-companion.spec.ts`
Expected: PASS。

- [ ] **Step 5: 改 `session.entity.ts` —— 删伴生字段/索引，kind 改 user|quick**

把 `apps/server-agent/src/entities/session.entity.ts` 改为（删第 13-16 行 `@Index`、第 36-43 行三字段；第 34 行 kind 去 `im`）：

```ts
import { SnowflakeBaseEntity } from "@meshbot/common";
import type { SessionStatus } from "@meshbot/types-agent";
import {
  Column,
  CreateDateColumn,
  Entity,
  UpdateDateColumn,
} from "typeorm";

/** 会话表。id 同时作为 LangGraph thread_id 与 socket.io room id。 */
@Entity("sessions")
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
  kind!: "user" | "quick";

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

（注意：`Index` 不再使用，已从 typeorm import 中移除。）

- [ ] **Step 6: typecheck 验证**

Run: `pnpm turbo typecheck --filter=@meshbot/server-agent`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor(server-agent): Session 删伴生字段/索引 + 迁移 1780600000000 删列/索引/数据"
```

---

## Task 3: 删前端死代码 + i18n + 注释

**Files:**
- Delete: `apps/web-agent/src/rest/im-agent.ts`, `apps/web-agent/src/components/im/agent-toggle.tsx`
- Modify: `apps/web-agent/messages/en.json`, `apps/web-agent/messages/zh.json`, `apps/web-agent/src/hooks/use-session-stream.ts`

**Interfaces:**
- Consumes: 无（这两个文件零导入）。

- [ ] **Step 1: 删两个死代码文件**

先确认零导入（应无输出）：
```bash
cd /Users/grant/Meta1/meshbot
rg -rn "rest/im-agent|AgentToggle|agent-toggle" apps/web-agent/src --glob '!**/rest/im-agent.ts' --glob '!**/agent-toggle.tsx'
```
然后删：
```bash
git rm apps/web-agent/src/rest/im-agent.ts apps/web-agent/src/components/im/agent-toggle.tsx
```

- [ ] **Step 2: 删 i18n 伴生 key（en.json + zh.json）**

在 `apps/web-agent/messages/zh.json` 与 `apps/web-agent/messages/en.json` 删除这 7 个 key 的全部出现（约第 325-331 行的「有值」块，以及约第 575-581 行的「空值 fallback」块）：
`agentPanelTitle`、`agentSuggestion`、`agentSendToConversation`、`agentNoCandidate`、`agentInputPlaceholder`、`agentEmptyHint`、`agentDisabledHint`。
先 `rg -n "agentPanelTitle|agentSuggestion|agentSendToConversation|agentNoCandidate|agentInputPlaceholder|agentEmptyHint|agentDisabledHint" apps/web-agent/messages/en.json apps/web-agent/messages/zh.json` 定位所有行号，逐个删除对应 JSON 行（注意删后保持 JSON 合法：相邻行逗号）。

- [ ] **Step 3: 改 `use-session-stream.ts` 注释**

在 `apps/web-agent/src/hooks/use-session-stream.ts` 第 58 行附近，把 JSDoc 里「sessionId 为 null 时惰性 inert（不请求不订阅）—— 供侧栏在伴生会话未就绪时安全挂载。」改为去伴生措辞的通用描述：

```ts
 * sessionId 为 null 时惰性 inert（不请求不订阅），可安全挂载。
```

- [ ] **Step 4: typecheck + i18n 对齐验证**

Run: `pnpm turbo typecheck --filter=@meshbot/web-agent`
Expected: 全绿（删的两个文件无人 import）。

Run: `pnpm sync:locales -- --check` （或 `npx tsx scripts/sync-locales.ts -- --check`）
Expected: `missing=0, asymmetric=0`；en/zh 两侧伴生 key 都已删、保持对齐（伴生 key 不再出现在 orphan 列表）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(web-agent): 删伴生死代码（rest/im-agent、agent-toggle）+ i18n orphan key + 注释"
```

---

## Task 4: 集成验证（boot 迁移自动跑 + 全量 + 围栏）

> 删了 provider/controller + 改 entity + 新迁移：必须真启 server-agent 验证 DI 不崩、迁移自动跑成功、schema 干净。

**Files:** 无（验证）。

- [ ] **Step 1: 全包 typecheck**

Run: `pnpm typecheck`
Expected: 全绿。

- [ ] **Step 2: 全量 jest**

Run: `pnpm test`
Expected: 新迁移单测绿；session.service.spec 绿；im-agent 专属 spec 已删不再跑。2 个失败套件仍是已知预存在基线（`session.e2e`、`use-global-events.spec`），不得新增其它失败。

- [ ] **Step 3: libs/agent vitest 基线**

Run: `cd libs/agent && npx vitest run`
Expected: 9 个预存在基线失败不变（本次未碰 libs/agent）；passed 数不减。

- [ ] **Step 4: 真启 server-agent —— DI + 迁移自动跑（关键）**

Run: `pnpm dev:server-agent`，观察日志：① 迁移 `DropSessionImCompanionFields1780600000000` 执行（`migrationsRun:true` 启动自动跑）② 无 Nest DI 报错（删 ImAgentService/ImAgentController）③ 启动到 “Nest application successfully started” + 监听 3100。确认后停。
Expected: 正常启动；本地 `~/.meshbot/main.db` 的 sessions 表伴生列已删、`kind='im'` 数据已清。

- [ ] **Step 5: 静态围栏**

Run: `pnpm check`
Expected: exit 0（tx-fence 仍是 `conversation.service.ts:280` 预存在基线 `unchanged=1`）。

- [ ] **Step 6: 最终提交（如有验证修正）**

```bash
git add -A
git commit -m "test(server-agent): 伴生删除集成验证修正"
```

---

## Self-Review（已核对）

- **Spec 覆盖**：§3.1 后端代码（Task 1）；§3.2 entity（Task 2 Step 5）；§3.3 迁移（Task 2 Step 1-4）；§3.4 前端死代码+i18n+注释（Task 3）；§4 不变量（保留 relay/EventsGateway/kind user·quick/listAllSorted 过滤 —— Task 1 Step 2/3 明确不动）；§5 测试与验证（迁移单测 Task 2、boot Task 4）。
- **占位符**：无 TBD/TODO；迁移与单测给完整代码；删除步给确切文件/方法/行段定位 + 确认命令。
- **类型一致**：迁移类名 `DropSessionImCompanionFields1780600000000` 在单测 import、迁移定义、boot 日志三处一致；entity 改后 `kind: "user" | "quick"` 与迁移删的列（im_conversation_id/im_conv_type/agent_enabled）、`listAllSorted` 的 `kind='user'` 过滤一致；`isUniqueViolation` 删除与其唯一调用方（findOrCreateImCompanion）同 Task 删除。
