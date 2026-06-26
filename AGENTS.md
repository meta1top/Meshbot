# AGENTS.md

本文件指导 Codex 在 meshbot 仓库的工作方式。

## 常用命令

### 开发

| 命令 | 说明 |
|------|------|
| `pnpm dev:server-agent` | 本地 Agent 后端（NestJS watch，端口 3100） |
| `pnpm dev:server-main` | 云协同后端（NestJS watch，端口 3200） |
| `pnpm dev:web-agent` | 桌面端 UI（Next.js，端口 3001） |
| `pnpm dev:web-main` | 云协同前端（Next.js，端口 3002） |
| `pnpm dev:desktop` | Electron 桌面壳 |
| `pnpm dev:cli-agent` | 命令行 Agent |

### 构建与测试

- `pnpm build` — Turbo 拓扑构建
- `pnpm test` — Jest（root 配置，覆盖 libs/common 与 server-agent）
- `pnpm typecheck` — 全包 TS 类型检查
- `pnpm lint` / `pnpm format` — Biome
- `pnpm clean:imports` — 自动移除未使用 import（Biome）

### 静态围栏（写完代码必跑）

```bash
pnpm check          # 串行跑下面 6 个；pnpm check:parallel 并行
pnpm check:tx
pnpm check:naming
pnpm check:lock-tx
pnpm check:repo
pnpm check:dead
pnpm check:error-code
pnpm check:strict   # CI 用，所有围栏 strict 模式
```

## 项目架构

meshbot 是 **本地优先 + 云端协同** 的双形态 AI Agent 平台。

```
apps/
├── server-agent/   NestJS 本地 Agent 后端（SQLite + LangGraph）
├── server-main/    NestJS 云协同后端（Postgres）
├── web-agent/      Next.js 桌面端 UI
├── web-main/       Next.js 云协同前端
├── desktop/        Electron 壳（fork server-agent）
└── cli-agent/      命令行 Agent 工具

libs/
├── common/         NestJS 基础设施（装饰器 / TxTypeOrmModule / Lock / Cache / Dto）
├── agent/          Agent 域 LangGraph 编排
├── types/          跨域 Zod schema + TS 类型
├── types-agent/    Agent 域 schema
└── types-main/     云协同域 schema

packages/
├── web-common/     Web 公共逻辑（前端 Next.js shared，原 packages/common）
└── design/         shadcn/Radix UI 组件库
```

**依赖方向**：`apps/server-*` → `libs/<domain>` → `libs/types-<domain>` → `libs/common`。只允许从上到下、从右到左，禁止反向。

**两轨**：
- **本地轨**（server-agent + cli-agent + desktop + web-agent）：单进程 + SQLite + 单用户，跑全部 Agent 业务逻辑
- **云端轨**（server-main + web-main）：Postgres + Redis + 多租户，只跑协同元数据 CRUD，**不跑 Agent 逻辑**

## 关键约定

### Repository 访问规范（check:repo）

- 每个 TypeORM Entity 有且仅有一个归属 Service（唯一持有 `@InjectRepository(X)` 的类）
- Controller / Gateway / Tool 禁止直接注入 Repository，必须通过归属 Service 访问
- 跨 `libs/<domain>/` 边界禁止注入其他模块的 Entity Repository

### 事务、锁、缓存（仅在 Service 层）

- **`@Transactional()`**：**跨表写入时使用**。单表 upsert / 单表 update 不需要。模块用 `TxTypeOrmModule.forFeature()` 注册 Entity（替代 `TypeOrmModule.forFeature()`）。事务上下文通过 AsyncLocalStorage 自动传播到子 Service。
- **`@WithLock`**：并发竞态/幂等保护。**必须在 `@Transactional` 外层**（锁包事务），严禁事务内嵌套锁（事务-锁倒置，`pnpm check:lock-tx` 自动校验）。
- **`@Cacheable` / `@CacheEvict`**：每个 `@Cacheable` 必须配对至少一个 `@CacheEvict`。缓存键格式：`模块:实体:#{参数索引或路径}`。

### 事务方法命名（check:naming）

私有 `@Transactional()` 方法命名必须命中以下约定之一：`*InDb`、`*InTx`、`*InTransaction`、`persist*`。反向也成立：私有方法名命中这些后缀 → 必须挂 `@Transactional()`。

### 数据库规范

- **本地轨**（SQLite）：用 TypeORM 迁移文件管理 schema（`synchronize:false` + `migrationsRun:true`，启动自动跑迁移，桌面端单节点自升级）；DataSource 启用 `journal_mode=WAL` + `busy_timeout=5000` 缓解 SQLITE_BUSY（通过 `prepareDatabase` 回调）
- **云端轨**（Postgres）：纯 SQL DDL 文件 `apps/server-main/migrations/<YYYYMMDDHHmm>-<english-summary>.sql`，**DBA 手动执行，服务任何模式都不自动建表 / 跑迁移**；幂等 SQL（`IF NOT EXISTS`）+ 文件不可变（变更追加新文件）+ 列名 snake_case + 逻辑外键 + 线上大表索引 `CONCURRENTLY` 单独成文件。改 Entity 必须配套 DDL 文件，详见 `ddl-migration` 技能
- 禁止数据库级别外键约束（不使用 `@ManyToOne`/`@OneToMany`/`@JoinColumn`）

### Zod / DTO（共享数据模型）

- 跨域 schema 放 `libs/types`；域内 schema 放 `libs/types-<domain>`
- `libs/types-*` **禁止依赖 NestJS / TypeORM**
- 后端用 `createZodDto(schema)` 把 Zod 转 NestJS DTO 类
- Entity 与 Schema 分离：Entity 在业务代码或 `libs/<domain>/`，Schema 在 `libs/types-<domain>/`

### 前端表单

写表单走 `Form/FormItem` + `useSchema`（共享 Zod Schema + 多语言，详见 `web-form-convention` 技能）。

### 测试

- 新代码默认 Jest；`libs/agent` 历史用 vitest，不强行统一
- 装饰器、Provider、围栏脚本必须有单测
- E2E 测试覆盖 server-main（含 Postgres service）

### 其他

- 数据库列名 snake_case（项目配置 `SnakeNamingStrategy`）
- 公开方法包含中文 JSDoc
- 禁止在 `if` 前一行放置注释（Biome 格式化会破坏结构）
- 不新建 PRD 文档，设计决策记在对话或 commit 中

## 开发工作流

1. **brainstorm** —— 用 superpowers:brainstorming skill 探讨需求 / 确认范围
2. **writing-plans** —— 出实施 plan
3. **编码** —— TDD 优先（先写失败的单测）
4. **静态围栏** —— commit 前 `pnpm check`
5. **commit** —— 中文提交信息，遵循 conventional commits 风格

## 表归属

| 应用 | 数据库 | 当前 Entity |
|------|--------|-------------|
| server-agent | `agent.db`（SQLite，`~/.meshbot/`，TypeORM 迁移管理） | `CloudIdentity` / `Setting` / `ModelConfig` / `Session` / `SessionMessage` / `LlmCall` / `PendingMessage` |
| server-main | Postgres（SQL DDL 文件，DBA 手动执行） | `AppUser` / `Organization` / `Membership` / `Invitation`（云端身份 + 企业/组织；Phase 1） |
