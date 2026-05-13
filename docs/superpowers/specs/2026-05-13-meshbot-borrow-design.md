# meshbot 借鉴 platform 优秀设计 —— 全景路线图

- 日期：2026-05-13
- 范围：meshbot（本地 Agent + 云端协同）
- 参考：platform（云端多租户 AI Agent 平台）
- 形态：全景规划 spec + 分阶段独立 brainstorm/plan（本 spec 是路线图，后续每个 Phase 单独走 brainstorm → writing-plans → 实施）

---

## 1. 目标与范围

### 1.1 目标

建立 meshbot 借鉴 platform 的多期路线图，明确 7 块可借鉴资产（A–G）里"什么搬、什么改、什么不搬"，并把 Phase 1（地基）展开到可以直接进入 writing-plans 的颗粒度。

### 1.2 两条轨道 + 一个共享层

| 轨道 | 应用 | 形态 | 借鉴策略 |
|------|------|------|----------|
| **本地轨** | `server-agent` / `web-agent` / `cli-agent` / `desktop` | 单进程 + SQLite + 单用户，跑全部 Agent 业务逻辑（LangGraph / 工具 / MCP） | "轻量版 "：工程纪律对齐，去掉所有分布式假设（无 Redis / 无 MQ / 无多租户） |
| **云端轨** | `server-main` / `web-main` | Postgres + Redis + 多节点 + 多租户，**只跑协同元数据 CRUD**（Agent 注册、用户、组织、远程下发），**不跑 Agent 逻辑** | "完整版 "：原样吃下  基础设施（除 LangGraph/Agent-tools 等不适用部分） |
| **共享层** | `libs/types*` / `libs/common` / `packages/design` / `.claude/` / `scripts/` | 两轨复用 | 一份代码两轨复用，工作量摊薄 |

### 1.3 不做什么

- 不在 server-main 引入 LangGraph / E2B / Agent-tools / RAG / Memory（那是 server-agent 的事）
- 不引入 Nacos / RabbitMQ（meshbot 体量不需要）
- 不动 server-agent 已有业务语义（只重构边界，不改行为）
- 不放弃 Turborepo 切回  的 `pnpm --filter` 直驱（meshbot 现状更优）
- Phase 1 不写 .claude skills（Phase 2 做）
- Phase 1 不切 server-agent 的 `synchronize:true`（Phase 3 做）
- 本次不实现 CI/CD（Phase 4 做）

---

## 2. 资产可移植性矩阵（A–G）

### A. Service 层基础设施（装饰器 + TxTypeOrmModule）

| 内容 | 本地轨 | 云端轨 |
|---|---|---|
| `@Transactional` | ✅ 直接搬。SQLite 支持事务，AsyncLocalStorage 与数据库无关 | ✅ 原样搬 |
| `TxTypeOrmModule` | ✅ 必搬 | ✅ 原样搬 |
| `@WithLock` | ⚠️ 抽象出 `LockProvider` 接口；本地实现用 `async-mutex`（单进程互斥），禁用"分布式锁"语义 | ✅ Redis 实现 |
| `@Cacheable` / `@CacheEvict` | ⚠️ 内存 LRU 实现（`lru-cache`），不引入 Redis | ✅ Redis 实现 |
| lock-tx 检查（事务-锁倒置） | ✅ 与 runtime 无关，可搬 | ✅ |

**关键改造**：把 `RedisLockService` / `RedisCacheService` 抽成 `LockProvider` / `CacheProvider` 接口，本地注入内存版，云端注入 Redis 版，让两轨共用同一份装饰器代码。

**落地阶段**：Phase 1（装饰器 + TxTypeOrmModule + 接口位 + 本地默认实现）；Phase 3（云端 Redis 实现接入）。

### B. 静态围栏脚本

| 围栏 | 落地阶段 | 备注 |
|------|---------|------|
| `check:tx`（@Transactional 完整性） | Phase 1 | 与 A 同期 |
| `check:naming`（事务方法命名 `*InDb` / `*InTx` / `persist*`） | Phase 1 | 与 A 同期 |
| `check:lock-tx`（事务-锁倒置） | Phase 1 | 即使本地锁退化，规则仍然有效 |
| `check:repo`（Entity 唯一归属 + 跨 libs 边界） | Phase 1 | 配合 D |
| `check:dead`（死导出） | Phase 2 | 不紧急 |
| `check:error-code` | ⏸ 视 meshbot 是否引入错误码体系而定 | Phase 3 评估 |

**关键改造**：meshbot 目录已对齐 ，几乎无改造。ignore 列表需要把 `libs/agent` / `apps/cli-agent` / `packages/*`（非 NestJS 服务）加入。

### C. 共享数据模型分层（Zod + DTO + Form）

| 内容 | 本地轨 | 云端轨 |
|---|---|---|
| `libs/types/` 跨域 schema | ✅ 共用一份 | ✅ 共用一份 |
| `libs/types-agent/` | ✅ 域内 schema（已存在，扩展即可） | ❌ 不引用 |
| `libs/types-main/` ✨新建 | ❌ 不引用 | ✅ 域内 schema（注册 / 用户 / 组织） |
| `createI18nZodDto` | ✅ 搬，先无 i18n 版 | ✅ 搬 |
| `Form / FormItem / useSchema` | ✅ 加到 `packages/design` | ✅ 同左 |

**关键改造**：
1. 新建 `libs/types-main/`
2. `createI18nZodDto` 在  依赖 nestjs-i18n；Phase 1 实现"无 i18n 版"`createZodDto(schema)`，Phase 2 视 i18n 决策升级
3. `packages/design` 补 `Form / FormItem`（Phase 2）

**落地阶段**：Phase 1（schema 分层 + 无 i18n createZodDto）；Phase 2（Form/FormItem + i18n 升级，如需要）。

### D. 架构纪律规约

| 规约 | 本地轨 | 云端轨 |
|------|--------|--------|
| service-repo-access（Entity 唯一归属） | ✅ Phase 1 执行（server-agent 已合规） | ✅ server-main 从零写起就遵循 |
| controller-thin | ✅ Phase 1 规约，违例 Phase 2 迁 | ✅ |
| swagger-api-declaration | ✅ Phase 2 补全 | ✅ |
| migrations-ddl（幂等 SQL + CONCURRENTLY） | ⚠️ Phase 3 适配 SQLite（去 CONCURRENTLY，保留幂等语法） | ✅ Phase 3 原样搬（Postgres） |
| 关闭 `synchronize:true` | ⚠️ Phase 3 切换 | ✅ server-main 从一开始就用迁移文件 |

### E. .claude skills harness

| skill | 搬否 | 阶段 |
|-------|------|------|
| `service-tx-lock-cache` / `check-{transactional,method-naming,lock-tx,repo-access}` | ✅ | Phase 2 |
| `service-repo-access` / `controller-thin` / `swagger-api-declaration` | ✅ | Phase 2 |
| `shared-data-model` / `web-form-convention` | ✅ | Phase 2 |
| `migrations-ddl` / `archive-migrations` | ✅ | Phase 3 |
| `dev-workflow` / `bypass-mode-safety` / `check-dead-exports` | ✅ | Phase 2 |
| `-jira-epic-*` / `soc-security-audit` | ❌（业务专属） | — |
| `build-ui` / `implement-panel-card` | ❌（ web-app 专属） | — |

**关键改造**：skill 内容里的路径与触发条件 glob 替换为 meshbot 对应路径。

### F. 开发工作流

| 内容 | 阶段 |
|------|------|
| brainstorm → plan → 实施流程（superpowers） | Phase 1（立即对齐） |
| Jest 配置（server-agent / server-main） | Phase 1 |
| 静态围栏作为 pre-commit（husky/lefthook + lint-staged） | Phase 2 |
| 写入鲁棒性（幂等键 / 补偿）规约 | Phase 2 |
| E2E 测试 | Phase 3 |

### G. monorepo & 构建发布工具链

| 子项 | 借鉴/自创 | 本地轨 | 云端轨 | 阶段 |
|------|-----------|--------|--------|------|
| pnpm `onlyBuiltDependencies` / `peerDependencyRules` 严格收口 | 借鉴  | ✅ | ✅ | Phase 1 |
| Turborepo task graph（保留 meshbot 现状） | meshbot 已有 | ✅ 扩展 test / typecheck / check | ✅ 同 | Phase 1 |
| `nest build <app>` + dist 产物 | 借鉴  | ✅ | ✅ | Phase 1 |
| `scripts/post-build.js`（Next standalone 修补） | 借鉴  | ✅ web-agent | ✅ web-main | Phase 2 |
| `sync:locales` 脚本 | 借鉴  | 跟随 i18n | 跟随 i18n | Phase 2 |
| Dockerfile 模板（多阶段构建） | 借鉴  | ❌（跑在 Electron 内） | ✅ | Phase 3 |
| docker-compose（本地 Postgres + Redis） | 借鉴  `infra/` | ❌ | ✅ | Phase 3 |
| `electron-builder.yml`（桌面 installer） | meshbot 独创 | ✅ | ❌ | 已有 / Phase 4 release 流 |
| cli-agent npm publish 流程 | meshbot 独创 | ✅ Phase 3 设计 | ❌ | Phase 3 |
| 版本号统一策略（changesets vs 各自 semver） | meshbot 独创 | ✅ | ✅ | Phase 3 |
| 运维脚本（迁移 / smoke / queue） | 借鉴  | 暂不需要 | ✅ | Phase 3 |
| 围栏脚本 `check:*` | 同 B | ✅ | ✅ | Phase 1 |

**关键改造**：
1. Dockerfile 模板抽出共享 base（`apps/_dockerfile-template/` 或每 app 一份），多阶段 `base → deps → build → runner`
2. 发布产物矩阵：server-main / web-main → Docker；desktop → electron-builder 多平台；cli-agent → npm；server-agent 不单独发（打入 Electron 包）
3. 版本号策略：建议 changesets，公开发布物独立 semver；libs/packages 内部包跟主仓库版本
4. scripts/ 目录约定：tsx + 顶部 JSDoc 中文说明 + 命名 `<verb>-<noun>.ts`

---

## 3. 分期路线图

### 3.1 时间线

| Phase | 主题 | 内容 |
|-------|------|------|
| **Phase 1** | 地基：纪律 + 装饰器 + 数据模型 + 围栏 + scripts | A（装饰器 + TxTypeOrmModule + LockProvider/CacheProvider 接口 + 本地默认实现）/ B（check:tx, check:naming, check:lock-tx, check:repo）/ C（libs/types-main 骨架 + Entity-Schema 分离 + createZodDto 无 i18n 版）/ D（service-repo-access + controller-thin + swagger 规约）/ F（dev-workflow + Jest）/ G（scripts/ + pnpm 收口 + Turbo 任务扩展） |
| **Phase 2** | 工程化 harness：skills + pre-commit + 前端表单层 | E（搬运适用 skills）/ B（check:dead）/ C（Form/FormItem + i18n 决策）/ F（husky + lint-staged）/ G（post-build.js） |
| **Phase 3** | 云端轨起步 + 多形态发布：server-main / Redis / 迁移 / Docker | server-main 起步 / A（Redis 实现）/ D（migrations-ddl，脱 synchronize）/ G（Dockerfile + docker-compose + cli 发布 + changesets）/ F（E2E） |
| **Phase 4** | CI/CD 与生产发布 | GitHub Actions（围栏 + 测试 + docker build + electron-builder release + npm publish）/ 自动 changelog / 监控接入 |

### 3.2 依赖关系

```
Phase 1 地基
  ├── A 装饰器 + LockProvider 接口
  ├── B 静态围栏
  ├── C libs/types-main + Entity-Schema 分离
  ├── D 纪律规约 + server-agent 违例迁移
  ├── F dev-workflow + Jest
  └── G scripts/ + pnpm + Turbo
        │
        ▼
Phase 2 harness  ── 依赖 A/B/C/D 落地（skill 内容指向已存在代码）
  ├── E skills 搬运
  ├── F pre-commit ── 依赖 B
  ├── C Form/FormItem ── 依赖 C 的 schema 分层
  └── G post-build.js + i18n 决策
        │
        ▼
Phase 3 云端 + 多产物
  ├── server-main 起步 ── 依赖 A 的 LockProvider（接 Redis）
  ├── D 迁移规范 + 脱 synchronize
  ├── G Dockerfile + docker-compose + cli 发布
  └── F E2E
        │
        ▼
Phase 4 CI/CD ── 依赖 Phase 3 产物形态确定
```

---

## 4. Phase 1 详细设计（可直接进 writing-plans）

### Task 1.1 — 新建 `libs/common`，迁入装饰器与事务上下文

**目标**：建立 meshbot 的"common 基础库"，对齐  `libs/common/src/{decorators,typeorm,service}` 结构。

**落地位置**：
- 新建 `libs/common`（与 `libs/shared` 共存；shared 保留空壳避免引用更新）
- 新增：`libs/common/src/decorators/{transactional.decorator.ts, with-lock.decorator.ts, cacheable.decorator.ts, index.ts}`
- 新增：`libs/common/src/typeorm/{transaction-context.ts, tx-typeorm.module.ts, index.ts}`
- 新增：`libs/common/src/lock/{lock.provider.ts, memory-lock.provider.ts, index.ts}`
- 新增：`libs/common/src/cache/{cache.provider.ts, memory-cache.provider.ts, index.ts}`
- 新增：`libs/common/src/common.module.ts`
- 包名：`@meshbot/common`

**改造点**：
1. `transactional.decorator.ts` / `transaction-context.ts` / `tx-typeorm.module.ts` 从  拷贝，无须改动
2. `with-lock.decorator.ts` 从  拷贝，把对 `RedisLockService` 的硬依赖改为依赖 `LockProvider` 接口
3. `cacheable.decorator.ts` / `cache-evict.decorator.ts` 同上，依赖 `CacheProvider`
4. `LockProvider` 接口（`acquire(key, ttl): Promise<Release>`）+ `MemoryLockProvider`（基于 `async-mutex`）
5. `CacheProvider` 接口（`get/set/del/delByPattern`）+ `MemoryCacheProvider`（基于 `lru-cache`）
6. `common.module.ts` 默认 provide 内存版 Provider；后续云端轨 `forRoot({ lock: 'redis', cache: 'redis' })` 切换

**验收标准**：
- `pnpm --filter @meshbot/common build` 通过
- server-agent 引用 `@Transactional` 后 `pnpm dev:server-agent` 正常启动
- 单元测试：跨 service 嵌套调用 `@Transactional` 方法时事务正确传播

### Task 1.2 — server-agent 接入 TxTypeOrmModule

**目标**：把 `TypeOrmModule.forFeature([Entity])` 替换为 `TxTypeOrmModule.forFeature([Entity])`。

**落地位置**：[apps/server-agent/src/app.module.ts](apps/server-agent/src/app.module.ts) 第 30 行；后续新增模块同步使用。

**改造点**：单行替换；`forRoot` 继续用原生 `TypeOrmModule.forRoot`。

**验收标准**：现有功能回归通过；事务装饰器在 service 嵌套调用中表现正确（单测覆盖）。

### Task 1.3 — 静态围栏脚本搬运（B 资产）

**目标**：4 个核心围栏在 meshbot 跑通。

**落地位置**：
- `scripts/check-transactional.ts`
- `scripts/check-method-naming.ts`
- `scripts/check-lock-tx.ts`
- `scripts/check-repo-access.ts`
- `package.json`：`check:tx` / `check:naming` / `check:lock-tx` / `check:repo`

**改造点**：
- 调整脚本里的 `libs/**` / `apps/server-*/src/**` glob（基本一致）
- 移除  专属忽略路径（rag / memory / agent-tools）
- 添加 ignore：`libs/agent` / `apps/cli-agent` / `packages/*`（非 NestJS 服务）
- 装 `tsx` 作为脚本运行器

**验收标准**：四个脚本在当前 server-agent 代码上跑通且通过（有违例必须修到通过）。

### Task 1.4 — `libs/types-main` 骨架 + Entity-Schema 分离规约（C 资产）

**目标**：建立 meshbot 共享 schema 分层，server-main 未来从零写起就遵守。

**落地位置**：
- 新建：`libs/types-main/{src/index.ts, package.json, tsconfig.json}`，包名 `@meshbot/types-main`
- 既有 `libs/types` / `libs/types-agent` 保持不变
- 新增：`libs/common/src/dto/create-zod-dto.ts`（无 i18n 版）

**改造点**：
- `createZodDto` 从  拷贝，去掉 nestjs-i18n 依赖，错误信息用 Zod 默认（Phase 2 视决策升级）
- CLAUDE.md 写明：`libs/types-*` 禁止依赖 NestJS / TypeORM

**验收标准**：
- `libs/types-main` 可被 server-main / web-main 引用
- 一份 sample schema（不落表）能在 server-agent 端用 `createZodDto` 转出 DTO 类

### Task 1.5 — 纪律规约写入 CLAUDE.md（D + F 资产）

**目标**：把  的工程规约浓缩成 meshbot 的 `.claude/CLAUDE.md`。

**落地位置**：`.claude/CLAUDE.md`（新建）

**内容**：
- 常用命令表（dev / build / test / check）
- 项目架构图（两轨 + libs 依赖方向）
- 关键约定：Repository 访问规范 / 装饰器使用 / 数据库规范（SQLite 限制）/ 表归属与迁移（agent.db 现状 + server-main 未来 Postgres）
- 静态围栏命令清单
- dev-workflow（brainstorm → 编码 → 单元测试 → 围栏）
- 前端表单（推迟到 Phase 2 补全）

**验收标准**：新 Claude Code 会话能正确加载并自动遵守（人工验证一次）。

### Task 1.6 — Jest 配置 + 装饰器/围栏单元测试（F 资产）

**目标**：建立测试基线。

**落地位置**：
- 根 `jest.config.ts`（参考  根配置）
- `libs/common/test/` 装饰器单测
- `scripts/__tests__/` 围栏脚本单测（fixture 文件）

**改造点**：
- 现有 `libs/agent` 用 vitest，不强行统一（保留），新代码默认 jest
- 装饰器单测覆盖：嵌套传播、回滚、`@WithLock` 内存实现互斥语义

**验收标准**：`pnpm test` 全通过。

### Task 1.7 — Turbo 任务扩展 + pnpm 收口对齐 + scripts/ 目录约定（G 资产）

**目标**：构建编排层补齐，pnpm 配置对齐  严格度。

**落地位置**：
- [turbo.json](turbo.json)：新增 `test` / `typecheck` / `check` / `check:tx` / `check:naming` / `check:lock-tx` / `check:repo` 任务
- [pnpm-workspace.yaml](pnpm-workspace.yaml)：补 `peerDependencyRules`（NestJS 11 统一）+ 收口 `onlyBuiltDependencies`
- [package.json](package.json)：新增 root 脚本 `check`（一键跑所有围栏）
- `scripts/README.md`：声明脚本命名约定（tsx、`<verb>-<noun>.ts`、顶部 JSDoc 中文说明）

**验收标准**：
- `pnpm check` 一键跑通所有围栏
- `pnpm typecheck` 全包通过
- `pnpm install` 在干净环境无 peer dep 警告

### Task 1.8 — server-agent 现有代码合规扫描与修补

**目标**：server-agent 全量扫一遍，让 4 个围栏通过；识别 controller-thin / swagger 违例（不一定 Phase 1 全修，列出 issue）。

**落地位置**：server-agent 全量

**改造点（预期）**：
- 给现有 `auth.service.ts` / `setting.service.ts` / `model-config.service.ts` 中跨表写入方法挂 `@Transactional`
- 私有事务方法重命名为 `*InDb` / `*InTx`（如果有）
- Controller 业务逻辑下沉（识别即可，真正修复留到 Phase 2 skills 上来后逐步迁）
- Swagger 装饰器空白处暂不强制（Phase 2 跟 skill 一起补）

**验收标准**：`pnpm check` 全绿；server-agent 行为无回归。

### Phase 1 整体退出标志

- `pnpm check` / `pnpm test` / `pnpm typecheck` / `pnpm build` 全部通过
- `libs/common` + `libs/types-main` 上线
- server-agent 接入 `@Transactional` + `TxTypeOrmModule`，无回归
- `.claude/CLAUDE.md` 注入新会话生效
- Phase 2 准备好的入口：skills 搬运可以直接拿来用

---

## 5. 风险 / 未决问题 / Phase 2-4 草图

### 5.1 已知风险（Phase 1 关注）

| # | 风险 | 触发场景 | 缓解 |
|---|------|---------|------|
| R1 | SQLite 事务 BUSY | TypeORM 默认 `BEGIN DEFERRED`，并发写时升级写锁会抛 `SQLITE_BUSY` | DataSource 配置 `pragma=journal_mode=WAL` + `busy_timeout=5000`；事务装饰器外可加重试包装 |
| R2 | `libs/shared` 改名 | 当前已引用 `@meshbot/shared` | 保留 `libs/shared` 空壳并新建 `libs/common`，避免改名风险 |
| R3 | Electron fork 子进程 AsyncLocalStorage | server-agent 通过 desktop fork 启动 | Task 1.1 完成后跑 desktop + server-agent 联调，验证事务上下文不漏 |
| R4 | vitest / jest 双轨 | libs/agent 已用 vitest | turbo `test` 任务接受两种 runner；CLAUDE.md 写明"新代码默认 jest" |
| R5 | `synchronize:true` 与新 Entity 冲突 | Phase 1 不切迁移文件 | Task 1.4 sample schema 不落表；任何 Phase 1 新 Entity 都需评估 |
| R6 | 围栏脚本路径假设 |  脚本硬编码路径 | Task 1.3 接入时逐脚本核对 |
| R7 | cli-agent / libs/agent / packages/* 被围栏意外扫到 | 默认扫 `libs/**` + `apps/server-*/**` | Task 1.3 加 ignore 配置 |

### 5.2 未决问题

**Phase 1 开始前需确认**：
- Q1：`libs/shared` 保留空壳还是删除？（建议保留空壳）
- Q2：server-main 是否给最小骨架？（建议 Phase 3 起步时再说）

**Phase 2 开始前需敲定**：
- Q3：meshbot 是否上 i18n？影响 createZodDto 升级、sync:locales 是否搬、`useSchema` 是否注入 t()
- Q4：husky 还是 lefthook？pre-commit 跑全量围栏还是只跑 lint-staged 增量？

**Phase 3 开始前需敲定**：
- Q5：版本号策略 — changesets / release-please / 各自独立 semver？
- Q6：cli-agent 发布形态 — 公开 npm / 私有 registry / brew tap / 直接内置 desktop？
- Q7：server-main 部署目标 — 自托管 docker / k8s / Serverless？
- Q8：监控选型 — Sentry / OpenTelemetry / 自研？

**Phase 4 开始前需敲定**：
- Q9：CI 平台 — GitHub Actions / GitLab / 自建？
- Q10：electron-builder 签名与公证 — 证书准备情况？

### 5.3 Phase 2 草图

- E：搬运 12 个适用 skills（`service-tx-lock-cache` / 4 个 `check-*` / `service-repo-access` / `controller-thin` / `swagger-api-declaration` / `shared-data-model` / `dev-workflow` / `bypass-mode-safety` / `archive-migrations`）
- B：`check:dead-exports`
- C：`Form` / `FormItem` / `useSchema` 进 `packages/design`；若 Q3=上 i18n，则 useSchema 注入 t()
- F：husky/lefthook + lint-staged + pre-commit 跑围栏
- G：`scripts/post-build.js` 从  拷过来
- i18n 决策落地（若上）：nestjs-i18n + next-intl + sync:locales + `createI18nZodDto` 升级 + `web-form-convention` skill

退出标志：Claude Code 在 meshbot 新会话能正确触发 skill；pre-commit 自动跑围栏；web 表单走 Form/FormItem。

### 5.4 Phase 3 草图

**server-main 起步**：
- `apps/server-main/src/` 实质实现
- 第一批领域：`libs/main/` + `libs/types-main/` 扩展 — User / Organization / Membership / AgentRegistration / Device / AuditLog
- 数据库：Postgres + 迁移文件（`apps/server-main/migrations/`）
- Redis 接入 `LockProvider` / `CacheProvider`
- JWT auth（与 server-agent 的本地 auth 分开）

**migrations-ddl 全规范**：
- 幂等 SQL / `CONCURRENTLY` 索引 / 逻辑外键 / snake_case / `SnakeNamingStrategy`
- server-agent 同步切到迁移文件，关闭 `synchronize:true`

**Docker 化**：
- `apps/server-main/Dockerfile` + `apps/web-main/Dockerfile`
- `infra/docker-compose.yaml`（本地 Postgres + Redis）
- `docker:server-main` / `docker:web-main` 脚本

**发布产物决策落地**：
- changesets 引入 + 版本策略（基于 Q5）
- cli-agent 发布路径（基于 Q6）
- `pnpm release:dry` smoke 脚本

**E2E**：`apps/server-main/test/e2e/` 起步。

退出标志：server-main 第一批 endpoint 上线；本地 docker-compose 起 Postgres + Redis 跑通；server-agent 脱 `synchronize:true`；cli-agent 可手动 release 出第一个版本。

### 5.5 Phase 4 草图

- CI：lint + check + test + typecheck + build matrix
- CD：
  - server-main / web-main：docker build & push（GHCR 或自托管 registry）
  - desktop：electron-builder release（mac / win / linux），签名公证
  - cli-agent：npm publish
- 自动 changelog（changesets 生成）
- 监控（基于 Q8）：Sentry / OTel hook 进 libs/common

退出标志：合主分支自动跑出全套产物；release 一键发布；线上有监控数据回流。

---

## 6. 下一步

本 spec 通过后，进入 **writing-plans skill**，为 **Phase 1** 撰写详细实施计划（plan）。

后续每个 Phase 在开始前重新走一次 brainstorm（敲定该 Phase 的未决问题）→ writing-plans → 实施。
