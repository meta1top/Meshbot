# Snowflake Primary Keys — Design Spec

**日期：** 2026-06-18  
**状态：** 已批准，待实施

---

## 问题背景

当前 15 张表（8 个 server-agent + 7 个 server-main）全部使用 UUID 或手动字符串作主键，
项目虽已实现 `SnowflakeIdGenerator`（`libs/common/src/utils/snowflake.ts`）但从未实际使用。
UUID 主键的缺点：36 字符开销大、B+ 树插入随机（索引碎片）、无时间有序性。

**目标：**
1. 将所有表主键改为雪花 ID（19-20 位十进制字符串，时间有序）
2. 引入 `SnowflakeBaseEntity` 基类 + `check:pk` 围栏，确保未来新表自动遵守

**前提：** 数据库可清空重建，无需 backfill 迁移。

---

## 架构概览

```
libs/common/src/entities/snowflake-base.entity.ts   ← 新增：抽象基类
apps/server-agent/src/entities/*.entity.ts           ← 改造：extends SnowflakeBaseEntity
libs/main/src/entities/*.entity.ts                   ← 改造：extends SnowflakeBaseEntity
apps/server-agent/src/migrations/<ts>-SnowflakePrimaryKeys.ts  ← 新增：DROP+CREATE
apps/server-main/migrations/<ts>-snowflake-primary-keys.sql    ← 新增：DROP+CREATE DDL
scripts/check-pk.ts                                  ← 新增：围栏脚本
package.json (root)                                  ← 新增 check:pk，追加进 check/check:parallel
```

---

## ① SnowflakeBaseEntity

**文件：** `libs/common/src/entities/snowflake-base.entity.ts`

```ts
import { BeforeInsert, PrimaryColumn } from "typeorm";
import { generateSnowflakeId } from "../utils/snowflake";

export abstract class SnowflakeBaseEntity {
  @PrimaryColumn({ type: "varchar", length: 20 })
  id!: string;

  @BeforeInsert()
  protected generateId() {
    if (!this.id) this.id = generateSnowflakeId();
  }
}
```

- `protected` 让子类可 override（例如需要外部传入固定 ID 的测试场景）
- `!this.id` 守卫：外部显式赋值时不覆盖（测试用）
- 放入 `libs/common/src/entities/` 目录，在 `libs/common/src/index.ts` 追加 `export * from "./entities"` 导出

---

## ② Entity 改造清单

### 普通表（删 UUID 生成，直接继承基类）

| 服务 | Entity 文件 | 改动 |
|------|-------------|------|
| server-agent | `session.entity.ts` | `@PrimaryGeneratedColumn("uuid")` → `extends SnowflakeBaseEntity` |
| server-agent | `llm-call.entity.ts` | 同上 |
| server-agent | `model-config.entity.ts` | 同上 |
| server-agent | `pending-message.entity.ts` | 同上（id 仍由服务层生成，改用 `generateSnowflakeId()`） |
| server-agent | `cron-job.entity.ts` | `@PrimaryColumn()` + 服务层 `randomUUID()` → `extends SnowflakeBaseEntity`；`schedule.service.ts` 的 `create()` 删掉 `const id = randomUUID()` 和 `repo.save({ id, ... })` 中的 `id` 字段，让 `@BeforeInsert` 接管 |
| server-main | `app-user.entity.ts` | `@PrimaryGeneratedColumn("uuid")` → `extends SnowflakeBaseEntity` |
| server-main | `organization.entity.ts` | 同上 |
| server-main | `membership.entity.ts` | 同上 |
| server-main | `invitation.entity.ts` | 同上 |
| server-main | `conversation.entity.ts` | 同上 |
| server-main | `conversation-member.entity.ts` | 同上 |
| server-main | `message.entity.ts` | 同上 |

### 特殊表

**`session_messages`（脱钩 LangGraph ID）**

```ts
@Entity("session_messages")
export class SessionMessage extends SnowflakeBaseEntity {
  /** 原 LangGraph / checkpointer message ID，用于三方关联查询。 */
  @Column({ name: "langgraph_id", type: "varchar", nullable: true })
  langgraphId!: string | null;

  // ...其余字段完全不变
}
```

写入逻辑变化：服务层把原来的 LangGraph UUID（`pending_messages.id`）存入 `langraphId`，`id` 由 `@BeforeInsert` 自动生成。

**`cloud_identity`（加代理键）**

```ts
@Entity("cloud_identity")
export class CloudIdentity extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text", unique: true })
  cloudUserId!: string;       // 原 PK → 唯一索引列，业务查询仍用此字段

  // ...其余字段不变
}
```

**`settings`（加代理键）**

```ts
@Entity("settings")
@Unique(["cloudUserId", "key"])
export class Setting extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column()
  key!: string;

  // ...其余字段不变
}
```

---

## ③ 迁移策略

### server-agent（SQLite，TypeORM 迁移）

新文件：`apps/server-agent/src/migrations/<timestamp>-SnowflakePrimaryKeys.ts`

`up()` 逻辑：
1. DROP 所有 8 张表（按依赖顺序：session_messages → llm_calls → cron_jobs → pending_messages → sessions → model_configs → cloud_identity → settings）
2. CREATE TABLE 按新 schema（主键 `VARCHAR(20)` 而非 `CHAR(36)`）
3. 重建全部索引和唯一约束

`down()` 逻辑：同样 DROP + CREATE（恢复 UUID schema），数据丢失可接受。

启动时 `migrationsRun: true` 自动执行，本地 `~/.meshbot/agent.db` 清空重建。

### server-main（Postgres，DDL SQL 文件）

新文件：`apps/server-main/migrations/<YYYYMMDDHHmm>-snowflake-primary-keys.sql`

内容：
1. `DROP TABLE IF EXISTS` 所有 7 张表（按依赖顺序）
2. `CREATE TABLE` 按新 schema（主键 `VARCHAR(20)`，移除 `DEFAULT gen_random_uuid()`）
3. 重建索引

DBA 手动执行。文件遵循现有规范（幂等、不可修改、snake_case 列名）。

---

## ④ check:pk 围栏脚本

**文件：** `scripts/check-pk.ts`

检查逻辑：
1. glob `**/*.entity.ts`（所有 apps/server-* 和 libs/ 下）
2. 跳过 `snowflake-base.entity.ts` 自身
3. 对包含 `@Entity(` 的文件检查：
   - 是否有 `extends SnowflakeBaseEntity`（或 import + 继承）
   - 是否残留 `@PrimaryGeneratedColumn`
   - 是否残留裸 `@PrimaryColumn`（不在 SnowflakeBaseEntity 中）
4. 任何违规 → 打印 `[check:pk] FAIL: path/to/file.entity.ts — 类名 缺少 SnowflakeBaseEntity 继承` + exit 1

**package.json 变更（root）：**

```json
"check:pk": "tsx scripts/check-pk.ts",
"check": "... && pnpm check:pk",
"check:parallel": "... check:pk ..."
```

---

## ⑤ 测试策略

- `check:pk` 脚本自身有单测（`scripts/__tests__/check-pk.spec.ts`）：验证合规 entity 通过、UUID entity 失败、缺继承失败
- server-agent 迁移在 e2e 测试中通过 `synchronize: false` + `migrationsRun: true` 自动验证
- 手动冒烟：启动 dev server，创建 session / model-config，确认 id 是 19-20 位数字字符串

---

## 工作量估算

| 任务 | 复杂度 |
|------|--------|
| SnowflakeBaseEntity + 导出 | 小 |
| 12 张普通表 entity 改造 | 小（重复性高） |
| 3 张特殊表 entity 改造 | 中 |
| 服务层适配（session-message langraphId、schedule service、cron-job） | 中 |
| server-agent TypeORM 迁移 | 中 |
| server-main DDL SQL | 中 |
| check:pk 脚本 + 单测 | 中 |
| 集成进 pnpm check | 小 |
