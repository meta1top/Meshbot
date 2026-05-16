# meshbot Phase 实施历史

记录已完成的各 Phase 范围、关键产出、踩过的坑。每个 Phase 的设计文档与实施 plan
见 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`，本文件作为索引 + 摘要。

---

## Phase 1（地基）✅ 已完成

- `libs/common` 装饰器与基础设施（@Transactional / @WithLock / @Cacheable / TxTypeOrmModule / LockProvider / CacheProvider）
- 4 个静态围栏（check:tx / check:naming / check:lock-tx / check:repo）
- `libs/types-main` 骨架 + `createZodDto`（无 i18n 版）
- Jest 配置 + 装饰器单测（12 通过）
- Turbo / pnpm 配置对齐（peer dep 锁 NestJS 11）
- `server-agent` 接入 `TxTypeOrmModule` + `@Transactional`
- SQLite WAL pragma 通过 `prepareDatabase` 回调启用

---

## Phase 2（工程化 harness）✅ 已完成

- i18n 全栈接入（server-agent + server-main 后端 nestjs-i18n；web-main 前端 next-intl 镜像；web-agent 已有）
- `libs/common`: 新增 `createI18nZodDto`（基于 nestjs-zod）；隐藏 `LockInitializer` / `CacheInitializer`
- `packages/design`: 新增 `useSchema` hook（递归翻译 Zod schema）+ `Form`/`FormItem` 高层封装（子路径 `@meshbot/design/{form,hooks}`）
- 13 条规约 `.cursor/rules/` 与 `.claude/skills/` 双套（`sync-skills.ts` 单向派生）
- 第 5 个静态围栏：`check:dead-exports`（`pnpm check` 现 5 项联跑）
- husky pre-commit：biome (lint-staged) + `pnpm check` + `pnpm sync:skills -- --check` + 软告警 `sync:locales`
- `scripts/sync-locales.ts`：扫描 t() 调用对齐 locale JSON（missing/orphan/asymmetric）
- `post-build.js`：web-agent + web-main 的 Next standalone 兼容
- Phase 1 final review backlog 全部清空：删 zombie auth / 删 libs/shared / 移 PROVIDERS / 隐藏 Initializer / forRoot JSDoc / scripts/README.md --force-report 文档 / e2e 集成测

---

## Phase 3（云端轨框架基线）✅ 已完成

> 范围调整：原 spec 的 Membership / Invite / Organization 业务全部从 libs/main 剥离；只留**最小注册 / 登录示范**作为 server-main 框架基线。真实业务由 meshbot 自行迭代。

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

---

## Phase 4（CI/CD + Redis + Docker + 发布工具链）✅ 已完成

> 范围决策：用户明确推迟监控（Sentry / OTel）。业务迭代由 meshbot 自行迭代不在 Phase 4。

- **Track A（CI/CD）**：A0 修 Phase 3 残留 baseline → `.github/workflows/ci.yml` 主流水线（PR + push main，Linux + Node 22，Postgres + Redis 服务，install / lint / typecheck / `check:strict` / sync:* / test / build）+ 跨平台 docker-build 矩阵（server-main / server-agent，buildx + gha cache）；README 加 CI badge + CONTRIBUTING.md
- **Track B（Redis Provider）**：`libs/common/src/lock/redis-lock.provider.ts`（Redlock 单点变体，SET NX PX + token + Lua 释放）+ `libs/common/src/cache/redis-cache.provider.ts`（JSON + SCAN/DEL pipeline）+ `CommonModule.forRootAsync`（按 `ConfigService.REDIS_URL` 选 memory / redis）；server-main 切 forRootAsync；libs/main 不再自带 forRoot（必须根 AppModule 唯一注册）；e2e `describe.each([["memory"], ["redis"]])` 双链路；dev compose 加 redis 服务（宿主 6380 避冲突）
- **Track C（Docker）**：`apps/server-main/Dockerfile`（多 stage + `pnpm deploy --no-optional`，332MB）+ `apps/server-agent/Dockerfile`（build 装 python3/make/g++，runtime 装 sqlite-libs，432MB）+ `infra/prod/docker-compose.prod.yml`（postgres + redis + server-main 编排，secret 在 `.env.prod`）；server-agent `StaticModule.forRoot()` 找不到 web-agent 时降级 API-only
- **Track D（发布工具链）**：changesets 接入（`@meshbot/cli-agent` + `@meshbot/server-agent` + `@meshbot/desktop` `fixed` 组共享版本）+ `release.yml`（changesets/action PR-driven 自动发版 + 补 `@meshbot/desktop@<v>` tag）；删 `publish-cli.yml`（npm publish 由 changesets 自动处理）；改 `package-desktop.yml` 触发器 + 上传 GitHub Release；CHANGELOG.md 索引 + 各包占位
- **Track E（Phase 3 小琐事）**：E1 `ts-jest isolatedModules` 警告从 transformer options 迁到 `tsconfig.base.json` 的 `compilerOptions.isolatedModules`；E2 `pnpm check:parallel`（pnpm run regex 并行 5 围栏）—— pre-commit 10.7s → 6.2s

### Phase 4 期间踩的坑（仅记可复用经验）

- **pnpm deploy 默认带 optional deps**：typeorm 的 optional db 驱动（better-sqlite3、@swc 等）会被拉进 server-main 镜像。修复：`--no-optional` 显式裁剪；同时把 server-agent 实际 runtime 用的 `better-sqlite3` 从根 devDeps 移到 server-agent 直接 deps（不能被 `--no-optional` 误剔）
- **`describe.each` 多链路 e2e 时 Provider 重叠**：原 libs/main `MainModule` 自带 `CommonModule.forRoot()` 与 AppModule / 测试 module 的 forRoot 重复注册，导致装饰器拿到的 LockProvider 实例与预期不一致。修复：从 lib 移走 `CommonModule.forRoot()`，强制由根 AppModule 唯一注册
- **changesets `ignore` 与 `fixed` 互斥规则**：public 包不能依赖 ignored 私有包。修复：把内部 libs（common/main/types/...）从 ignore 中拿出来 —— private 包仍然不会被 publish，但会 bump 版本号
- **changesets 不为 private 包打 tag**：`@meshbot/desktop` 是 private，`changeset publish` 不创建 `@meshbot/desktop@<v>` tag。修复：`release.yml` 末尾根据 `apps/desktop/package.json.version` 手工补 tag → 触发 `package-desktop.yml`
- **`actions/checkout@v6` 等 v6 标签不存在**：迁移到当前 LTS `@v4`；同时 `actions/setup-node` 也对齐

---

## 设计依据

- `docs/superpowers/specs/` —— 各 Phase 设计文档
- `docs/superpowers/plans/` —— 各 Phase 实施 plan

---

## Phase 5（错误 / 响应 / Gateway / Ops 框架抽屉）✅ 已完成

> 监控 / 业务模型 / BullMQ 队列 / Idempotency / RBAC 推迟到未来。

- **Track A（错误 + 响应基石）**：
  - `libs/common/src/errors/` —— `ErrorCode` 接口 + `defineErrorCode` + `AppError` + `CommonErrorCode`（0 + 1-6 + 999）+ `ErrorsFilter`（合并 Phase 3 的 I18nExceptionFilter）
  - `libs/common/src/interceptors/response.interceptor.ts` —— 成功响应统一 envelope；`@SkipResponseEnvelope()` 跳过装饰器
  - 范围划分：common 0-999 / main 2000-2999 / agent 3000-3999；业务错误默认 HTTP 200 + envelope `success:false`
  - 迁移 `libs/main/MainErrorCode` + 新建 `apps/server-agent/src/errors/AgentErrorCode`；删 `throwMainError` + 旧 `I18nExceptionFilter`
  - server-agent / server-main main.ts 全局：pipe → interceptor → filter
- **Track B（Gateway 必备）**：
  - `libs/types/src/common/page.schema.ts`（PageRequestSchema z.coerce + PageData<T> + Envelope<T>）+ `libs/common/src/dto/page.dto.ts`（PageRequestDto + pageify）
  - `libs/common/src/middlewares/trace-id.middleware.ts` —— `x-trace-id` 透传 / 自动 UUID；req.traceId 流入 envelope；e2e 2 case
  - `libs/common/src/guards/proxy-throttler.guard.ts` —— proxy-aware（`x-forwarded-for` 首段）+ ThrottlerModule 三档桶（server-main） / 两档（server-agent）+ register 5/min、login 10/min
- **Track C（Ops 打磨）**：
  - `libs/common/src/utils/plain-text.logger.ts` —— TypeORM 纯文本 logger（生产启用，dev 保留 colored）+ slow-query 标记
  - server-main TypeORM `extra: { options: "-c timezone=UTC" }` 强制 UTC（生产）
  - `libs/common/src/health/redis-health.indicator.ts` —— 通过 LockProvider 探活；Terminus HealthController（server-agent /api/health + server-main /api/health 返回 DB + Redis 分组）
  - `apps/server-*/src/app.swagger.ts` —— Bearer auth 安全方案；dev 模式 `/api/docs`
- **Track D（Snowflake ID）**：
  - `libs/common/src/utils/snowflake.ts` —— 41bit 时间戳 + 10bit nodeId + 12bit 序列；EPOCH 2026-01-01；MESHBOT_NODE_ID env；6 单测
  - `.cursor/rules/shared-data-model.mdc` 加「主键策略」节：本地用 UUID，云端多实例 / 时间序业务用 Snowflake；多实例部署需配 NODE_ID
- **Track E（小琐事）**：
  - `scripts/check-error-code.ts` —— 第 6 个静态围栏；3 类 finding（DUPLICATE_CODE / OUT_OF_RANGE / GAP）；接入 pnpm check / check:strict / check:parallel / pre-commit
  - `.cursor/rules/service-repo-access.mdc` 加「软删除模式」节：`@DeleteDateColumn` + 部分唯一索引（`WHERE deleted_at IS NULL`）+ Service 行为约定 + 迁移 DDL 模式

### Phase 5 期间踩的坑（仅记可复用经验）

- **TypeORM v0.3 Logger 接口**：自定义 logger 必须实现 7 个方法（含 `log` / `logSchemaBuild` / `logMigration`），简化版用 NestLogger 转发输出
- **Terminus type inference**：`HealthCheckService.check` 返回类型 `Promise<HealthCheckResult>`，自动推断会引用 `@nestjs/terminus/dist` 的内部路径（不可移植），必须显式标注返回类型
- **AppError envelope HTTP 状态码语义**：业务错误（邮箱重复 / 密码错）走 HTTP 200 + envelope code，避免污染 4xx/5xx（这些留给框架级问题：限流 429 / 鉴权 401 / 未找到 404 等）。客户端按 `success` / `code` 判定
- **Throttle decorator 在测试模块下静默失效**：tests 不 import ThrottlerModule / ProxyThrottlerGuard 时，`@Throttle()` 的 metadata 仅设置但无 guard 读取，所以单元测试不受限流影响（测试代码无需额外 mock）
- **Snowflake 时钟回拨**：本实现选择「等回到 lastMs」而非抛错；NTP 大幅回拨时仍可能错乱，多实例部署额外依赖 NODE_ID 唯一性来避免冲突

---

## Phase 6（多实例正确性 + 启动期约束 + WebSocket 框架预备）✅ 已完成

- **Track A（Throttler Redis storage）**：`@nest-lab/throttler-storage-redis`；server-main AppModule 提 `REDIS_CLIENT` Symbol，由 `CommonModule.forRootAsync` 与 `ThrottlerModule.forRootAsync` 共享同一 Redis 实例，避免双连接池
- **Track B（RedisLock TTL watchdog）**：`AcquireOptions.{watchdog,renewIntervalMs}` 经 `@WithLock` 透传；`RedisLockProvider` 用 Lua `RENEW_SCRIPT`（token 校验 + PEXPIRE）按 `renewIntervalMs` 续期；token 不匹配 → 静默停 watchdog；`release()` 清定时器；`MemoryLockProvider` 是 no-op。`redis-lock.provider.spec.ts` 加 4 个 watchdog case（持续续期 / release 后停 / 抢占静默停 / 不启用时超 ttl 释放）
- **Track C（Snowflake auto NODE_ID + Zod env）**：
  - `libs/common/src/utils/snowflake.ts`：`deriveNodeId()` 优先级 `MESHBOT_NODE_ID env > FNV-1a(hostname()) & 0x3ff > 0`；`new SnowflakeIdGenerator()` 默认派生
  - `libs/common/src/config/env-schema.ts`：`createEnvValidator(schema)` 工厂；fail-fast 列字段路径
  - server-main / server-agent 各起 `env.schema.ts` + `ConfigModule.forRoot({ validate })`
- **Track D（WebSocket Gateway 框架）**：
  - `libs/common/src/ws/`：`WsAuthGuard`（读 `client.data.user` → 抛 `WsException(AppError(UNAUTHORIZED))`）、`WsExceptionFilter`（复用 `formatEnvelope` + 401 主动 disconnect + 事件名 `exception`）、`wsTraceMiddleware`（`x-trace-id` 透传 / 随机 UUID）、`createWsJwtMiddleware`（handshake 期 verify，失败不阻断 connect）、`BaseWebSocketGateway`（`afterInit` 串联两 middleware）
  - `libs/common/src/errors/format-envelope.ts`：HTTP / WS 共用 envelope 拼装；`ErrorsFilter` / `WsExceptionFilter` 都先 `host.getType()` 早返，避免跨上下文误处理
  - server-main `apps/server-main/src/ws/health.gateway.ts`：`@UseFilters(WsExceptionFilter)` + `@UseGuards(WsAuthGuard)` + `SubscribeMessage("ping")` 返回 `{ pong, traceId }`；e2e 3 case（合法 JWT → pong / 无 token → exception envelope code 2 + disconnect / 上游 traceId 透传）

### Phase 6 期间踩的坑（仅记可复用经验）

- **NestJS DI 元数据需要运行期 import**：`WsExceptionFilter` 用 `import type { I18nService }` 时 `__metadata("design:paramtypes", [Function])` —— 类型被擦除，DI 拿不到。改成 `import { I18nService }` + `biome-ignore lint/style/useImportType` 解决
- **socket.io 中 `error` 是保留事件**：服务端 `client.emit("error", ...)` 客户端不会通过 `socket.on("error", ...)` 收到自定义 payload。改用 `exception` 事件名（对齐 NestJS 内置 BaseWsExceptionFilter 约定）
- **pnpm peer-dep 变体导致 DiscoveryService DI 报错**：libs/common 加 `@nestjs/websockets` peer 后，pnpm 重新解析了 `@nestjs/core` 的 peer 变体路径；需 `pnpm install` 重做 node_modules 让所有 workspace 共享同一变体
- **handshake middleware 不应阻断**：JWT verify 失败时 `next()` 放行（而非 `next(err)`）；让 `WsAuthGuard` 在订阅消息时报错并通过 envelope 给客户端可见反馈，避免客户端只看到模糊的 `connect_error`
- **@UseFilters 需要 provider 注册**：`@UseFilters(WsExceptionFilter)` 用类引用时，Nest 通过 DI 实例化，需要把类加进 module providers；否则 `Nest can't resolve dependencies` 报错
