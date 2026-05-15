# CLAUDE.md

本文件指导 Claude Code 在 meshbot 仓库的工作方式。

## 常用命令

### 开发

| 命令 | 说明 |
|------|------|
| `pnpm dev:server-agent` | 本地 Agent 后端（NestJS watch，端口 3100） |
| `pnpm dev:server-main` | 云协同后端（NestJS watch，端口 3200，Phase 3 起有内容） |
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
pnpm check   # 一键跑下面 4 个
pnpm check:tx
pnpm check:naming
pnpm check:lock-tx
pnpm check:repo
```

## 项目架构

meshbot 是 **本地优先 + 云端协同** 的双形态 AI Agent 平台。

```
apps/
├── server-agent/   NestJS 本地 Agent 后端（SQLite + LangGraph）
├── server-main/    NestJS 云协同后端（Postgres，Phase 3 起步）
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

- **本地轨**（SQLite）：当前用 `synchronize: true`（Phase 3 切换到迁移文件）；DataSource 启用 `journal_mode=WAL` + `busy_timeout=5000` 缓解 SQLITE_BUSY（通过 `prepareDatabase` 回调）
- **云端轨**（Postgres，Phase 3 起）：迁移文件 + 幂等 SQL（`IF NOT EXISTS`）+ 索引 `CONCURRENTLY` + 列名 snake_case + 逻辑外键
- 禁止数据库级别外键约束（不使用 `@ManyToOne`/`@OneToMany`/`@JoinColumn`）

### Zod / DTO（共享数据模型）

- 跨域 schema 放 `libs/types`；域内 schema 放 `libs/types-<domain>`
- `libs/types-*` **禁止依赖 NestJS / TypeORM**
- 后端用 `createZodDto(schema)` 把 Zod 转 NestJS DTO 类（Phase 2 视决策升级为 i18n 版）
- Entity 与 Schema 分离：Entity 在业务代码或 `libs/<domain>/`，Schema 在 `libs/types-<domain>/`

### 前端表单（Phase 2 补全）

Phase 1 暂未引入 Form/FormItem 封装；现阶段写表单允许直接用 shadcn 组件。Phase 2 后必须走 `Form/FormItem` + `useSchema`。

### 测试

- 新代码默认 Jest；`libs/agent` 历史用 vitest，不强行统一
- 装饰器、Provider、围栏脚本必须有单测
- E2E 测试 Phase 3 起引入

### 其他

- 数据库列名 snake_case（项目配置 `SnakeNamingStrategy`，Phase 3 落地）
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
| server-agent | `agent.db`（SQLite，`~/.meshbot/`，TypeORM 迁移管理） | `User` / `Setting` / `ModelConfig` |
| server-main | Postgres（Phase 3，TypeORM 迁移管理） | `AppUser`（注册 / 登录框架基线；真实业务由 meshbot 自行扩展） |

## Phase 进度

### Phase 1（地基）✅ 已完成

- `libs/common` 装饰器与基础设施（@Transactional / @WithLock / @Cacheable / TxTypeOrmModule / LockProvider / CacheProvider）
- 4 个静态围栏（check:tx / check:naming / check:lock-tx / check:repo）
- `libs/types-main` 骨架 + `createZodDto`（无 i18n 版）
- Jest 配置 + 装饰器单测（12 通过）
- Turbo / pnpm 配置对齐（peer dep 锁 NestJS 11）
- `server-agent` 接入 `TxTypeOrmModule` + `@Transactional`
- SQLite WAL pragma 通过 `prepareDatabase` 回调启用

### Phase 2（工程化 harness）✅ 已完成

- i18n 全栈接入（server-agent + server-main 后端 nestjs-i18n；web-main 前端 next-intl 镜像；web-agent 已有）
- `libs/common`: 新增 `createI18nZodDto`（基于 nestjs-zod）；隐藏 `LockInitializer` / `CacheInitializer`
- `packages/design`: 新增 `useSchema` hook（递归翻译 Zod schema）+ `Form`/`FormItem` 高层封装（子路径 `@meshbot/design/{form,hooks}`）
- 13 条规约 `.cursor/rules/` 与 `.claude/skills/` 双套（`sync-skills.ts` 单向派生）
- 第 5 个静态围栏：`check:dead-exports`（`pnpm check` 现 5 项联跑）
- husky pre-commit：biome (lint-staged) + `pnpm check` + `pnpm sync:skills -- --check` + 软告警 `sync:locales`
- `scripts/sync-locales.ts`：扫描 t() 调用对齐 locale JSON（missing/orphan/asymmetric）
- `post-build.js`：web-agent + web-main 的 Next standalone 兼容
- Phase 1 final review backlog 全部清空：删 zombie auth / 删 libs/shared / 移 PROVIDERS / 隐藏 Initializer / forRoot JSDoc / scripts/README.md --force-report 文档 / e2e 集成测

### Phase 3（云端轨框架基线）✅ 已完成

> 范围调整：实施期间用户明确「不照搬  业务」。原 spec 的 Membership / Invite / Organization 业务全部从 libs/main 剥离；只留**最小注册 / 登录示范**作为 server-main 框架基线。真实业务由 meshbot 自行迭代。

- **A1**：`libs/common/src/dto/i18n-zod-validation.pipe.ts` 桥接 nestjs-zod ↔ nestjs-i18n（拦截 ZodIssue → 翻译 → 抛 400）；`I18nExceptionFilter` 翻译 service 层抛出的 i18n-key HttpException；server-agent / server-main 全局注册；e2e 强制翻译断言（中英）
- **B1**：`infra/dev/docker-compose.dev.yml`（Postgres 16-alpine）+ `pnpm dev:db:{up,down,reset,logs}` + `apps/server-main/.env.development.example`
- **B2**：server-main 接入 `TypeOrmModule.forRootAsync` + `SnakeNamingStrategy` + `migrationsRun:true`（dev）+ `apps/server-main/src/data-source.cli.ts`（CLI 用）
- **B3**：`libs/types-main` schema（仅 `register-user` + `login`）
- **B4**：`libs/main` 框架基线 —— `AppUser` 唯一归属 `UserService`，注册 / 登录 + bcrypt；`MainErrorKeys` + `throwMainError`；class+interface 声明合并暴露 zod-inferred 字段（绕过 TS `extends createZodDto(...)` instance type 丢失）
- **B5**：`apps/server-main/src/auth/` 独立 JWT chain（strategy 名 `jwt-main` vs server-agent 的 `jwt`）+ `@Public` / `@CurrentUser` + 全局 `JwtAuthGuard`；`rest/auth.controller.ts`（register / login）
- **B6**：`apps/server-main/src/migrations/1778869010469-InitialSchema.ts` 仅建 `app_user` 表 + 唯一索引 + pgcrypto
- **B7**：e2e 套 `test/e2e/auth-flow.spec.ts`（7 case 全绿）+ 隔离 schema 工具 `test/setup/test-db.ts`
- **B8**：server-main i18n 资源（auth / validation / common，zh+en）
- **C1**：server-agent 脱 `synchronize:true` —— `migrations/1778900000000-InitialSchemaSqlite.ts`（users / settings / model_configs）+ `data-source.cli.ts` + `migrationsRun:true`
- **C2**：根 `pnpm migration:{generate,run,revert,show,archive}:{main,agent}` 脚本（`TS_NODE_COMPILER_OPTIONS` 注入 decorators metadata）+ `scripts/archive-migrations.ts`
- **A2**：60 个 web-agent missing i18n key 全部 burn down（zh / en 双语，无空占位）
- **A3**：husky `.husky/pre-commit` `sync:locales --check` 软告警 → 硬失败

### Phase 3 期间踩的坑（仅记可复用经验，不复述配置细节）

- **pnpm 多实例同名 token**：libs/main 与 apps/server-main 的 `@nestjs/typeorm` 因 `@types/node` 版本不同被 pnpm split 成两份物理副本 → NestJS DI 解析 DataSource token 失败。修复：根 `package.json` 加 `pnpm.overrides.@types/node` + jest moduleNameMapper 强制 framework 包从单一物理路径解析
- **TypeORM 多 schema 测试**：`DataSource.schema` 仅设置 search_path 影响读，迁移 DDL 仍可能落 public。修复：测试 dataSource `extra.options: "-c search_path=<schema>"` 强制所有连接默认在测试 schema 内
- **TS `class X extends createZodDto(S) {}` 实例字段丢失**：用 class + interface 声明合并补字段类型（biome `noUnsafeDeclarationMerging` 逐个 ignore）
- **NodeNext + typeorm CLI 冲突**：`__dirname` 在 ESM 上下文失效。修复：data-source.cli.ts 用 `process.cwd()` 算 repo root，并通过 `TS_NODE_COMPILER_OPTIONS` 强制 commonjs 编译

### Phase 4 待办（按优先级）

- **业务迭代**：meshbot 自行定义云端协同业务模型并接入 server-main（参考但不照搬其它项目；新增实体走 `service-repo-access` + `service-tx-lock-cache` + `swagger-api-declaration` 规约 + 新增 TypeORM 迁移）
- **Redis**：`@WithLock` / `@Cacheable` 切 RedisProvider（Phase 3 仍是 MemoryProvider）
- **Dockerfile**：server-main / server-agent / cli-agent / desktop 各自 production 镜像 + docker-compose 编排
- **CI/CD**：GitHub Actions（lint + check + test + build matrix）
- **发布工具链**：版本号策略（changesets）/ electron-builder release / cli-agent npm publish / 自动 changelog
- **监控接入**：Sentry / OTel
- **小琐事**：`ts-jest isolatedModules` 配置迁移 / pre-commit 运行时调优

设计依据：`docs/superpowers/specs/2026-05-13-meshbot-borrow--design.md` + `docs/superpowers/specs/2026-05-14-meshbot-phase-3-design.md`。
