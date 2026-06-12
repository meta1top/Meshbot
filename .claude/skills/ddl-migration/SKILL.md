---
name: ddl-migration
description: "云端轨（server-main 等 Postgres 应用）数据库 schema 的 DDL 维护规则 —— 纯 SQL 文件 + DBA 手动执行，服务任何模式都不自动建表。Use when adding or modifying any Entity under libs/main/** or apps/server-main/**, creating new tables/columns/indexes for the cloud track, or when the user asks how to apply cloud database schema changes. NOT for server-agent (SQLite, TypeORM 自动迁移)."
---

# 云端 DDL 维护规则

云端轨（Postgres）schema 的唯一真相源是 **纯 SQL DDL 文件**，由 **DBA 手动执行**。
服务进程在任何模式（dev / production）下都**不自动建表、不自动跑迁移**——
`TypeOrmModule` 配置里没有 `migrationsRun` / `migrations` / `synchronize:true`，加回去即违规。

本地轨（server-agent，SQLite）**不适用本规则**：它保持 TypeORM 迁移 + 启动自动执行
（桌面端单节点自升级，无多副本并发风险），迁移文件在 `apps/server-agent/src/migrations/*.ts`。

## 文件位置与命名

```
apps/server-main/migrations/<YYYYMMDDHHmm>-<english-summary>.sql
```

- 时间戳精确到分钟（如 `202606130244`），决定执行顺序
- 英文说明用 kebab-case、描述这次变更做了什么，例如：
  - `202606130244-init-identity-and-org.sql`
  - `202607011030-add-task-board-tables.sql`
  - `202607150900-add-invitation-note-column.sql`
- 未来其他云端应用同理：`apps/server-<x>/migrations/*.sql`

## DDL 编写规则

1. **幂等**：所有语句可重复执行 —— `CREATE TABLE IF NOT EXISTS`、
   `CREATE INDEX IF NOT EXISTS`、`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`、
   `DROP ... IF EXISTS`。
2. **不可变**：文件一经提交（合入 main）不得再修改；要改 schema 就追加新文件。
   唯一例外：尚未在任何环境执行过、且未合入 main 的文件。
3. **列名 snake_case**；表名单数（与 Entity `@Entity("xxx")` 一致）。
4. **禁止数据库外键约束**（逻辑外键，与全仓约定一致）；需要的关联完整性由
   Service 层事务保证。
5. **索引**：开发/空表直接 `CREATE INDEX IF NOT EXISTS`；对线上大表加索引必须
   `CREATE INDEX CONCURRENTLY`，且这类语句**单独成文件**并在文件头注明
   "不能在事务内执行"（psql 直跑，不能包 BEGIN）。
6. 文件头部写注释块：本次变更的目的、执行方式、关联的 Entity / Phase。
7. 破坏性操作（DROP TABLE / DROP COLUMN / 数据迁移 UPDATE）必须在文件头注明
   影响与回滚方案，并在 PR 描述里显式提醒。

## Entity 与 DDL 同步（强约束）

改了 `libs/main/src/entities/*.entity.ts`（或新增 Entity）**必须**在同一改动里
追加对应的 DDL 文件；反之亦然。Review 时对照检查：

- Entity 列 ↔ DDL 列（snake_case 映射、类型、nullable、default）
- Entity `@Index` 装饰器 ↔ DDL 索引（含部分索引的 `where` 条件）

Entity 上的装饰器只是元数据文档（`synchronize:false`），真正生效的是 DDL。

## 执行流程

| 环境 | 谁执行 | 怎么执行 |
|------|--------|----------|
| 生产 / 预发 | DBA | 按文件名顺序 `psql -h <host> -U <user> -d <db> -f <file>.sql`，执行前 review |
| 本地开发库 | 开发者本人 | 同上，对 localhost 执行（或用任意 SQL 客户端跑文件内容） |
| e2e 测试 | 自动 | `apps/server-main/test/setup/test-db.ts` 按文件名顺序在隔离 schema 重放全部 `.sql` |

没有 pnpm 包装命令——执行 DDL 是显式的数据库运维动作，不藏在脚本后面。
由于幂等规则，重放整目录是安全的；新环境初始化 = 按序执行全部文件。

## 新增 DDL 的自检清单

- [ ] 文件名 `<YYYYMMDDHHmm>-<english-summary>.sql`，时间戳晚于目录中已有文件
- [ ] 全部语句幂等，整文件可重复执行
- [ ] 与 Entity 改动配套（双向核对列 / 索引）
- [ ] 在本地库执行过一遍验证语法
- [ ] `pnpm test -- apps/server-main/test/e2e` 通过（e2e 会重放全部 DDL）
- [ ] 含 CONCURRENTLY 的语句单独成文件并注明不可包事务
