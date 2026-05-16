# meshbot Phase 5 实施 Plan — 框架抽屉补全

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

- **Spec**: [2026-05-16-meshbot-phase-5-design.md](../specs/2026-05-16-meshbot-phase-5-design.md)
- **Date**: 2026-05-16
- **Goal**: 借鉴  框架细节补齐 NestJS 服务级基建 —— 错误码、统一响应、分页、Trace、限流、Health、Logger、Swagger、Snowflake、软删除规范
- **不在范围**: 监控、业务模型、BullMQ、Idempotency、Nacos、RBAC（见 spec §1.4）

---

## 依赖图

```
A1 ─→ A2 ─→ A5
A1 ─→ A3 ─→ A5
A1 ─→ A4 ─→ A5
A1 ─→ E2（check:error-code）
A5 ─→ B2（Trace ID 进入 envelope）
B1 / B3 / C1-C4 / D1-D2 / E1 独立
```

**推荐顺序**：A1 → A2 → A3 → A4 → A5 → E2 → B1 → B2 → B3 → C2 → C3 → C1 → C4 → D1 → D2 → E1

---

## Track A — 错误 + 响应基石

### Task A1: AppError + defineErrorCode + ErrorCode 注册

**Files**:
- Create: `libs/common/src/errors/error-code.ts`
- Create: `libs/common/src/errors/app.error.ts`
- Create: `libs/common/src/errors/common.error-codes.ts`
- Create: `libs/common/src/errors/index.ts`
- Modify: `libs/common/src/index.ts`

- [ ] **Step 1: ErrorCode 接口 + defineErrorCode helper**

  ```ts
  // libs/common/src/errors/error-code.ts
  export interface ErrorCode {
    code: number;
    message: string;       // i18n key
    httpStatus?: number;   // 默认 200
  }
  export function defineErrorCode<T extends Record<string, ErrorCode>>(codes: T): T {
    return codes;
  }
  ```

- [ ] **Step 2: AppError class**

  ```ts
  // libs/common/src/errors/app.error.ts
  export class AppError extends Error {
    constructor(
      public readonly errorCode: ErrorCode,
      public readonly data: unknown = null,
      public readonly i18nArgs: Record<string, unknown> = {},
    ) {
      super(errorCode.message);
      this.name = "AppError";
    }
  }
  ```

- [ ] **Step 3: CommonErrorCode（框架级）**

  ```ts
  // libs/common/src/errors/common.error-codes.ts
  export const CommonErrorCode = defineErrorCode({
    SUCCESS:             { code: 0,   message: "success" },
    VALIDATION_FAILED:   { code: 1,   message: "common.validationFailed",  httpStatus: 400 },
    UNAUTHORIZED:        { code: 2,   message: "common.unauthorized",      httpStatus: 401 },
    FORBIDDEN:           { code: 3,   message: "common.forbidden",         httpStatus: 403 },
    NOT_FOUND:           { code: 4,   message: "common.notFound",          httpStatus: 404 },
    CONFLICT:            { code: 5,   message: "common.conflict",          httpStatus: 409 },
    TOO_MANY_REQUESTS:   { code: 6,   message: "common.tooManyRequests",   httpStatus: 429 },
    INTERNAL_ERROR:      { code: 999, message: "common.internalError",    httpStatus: 500 },
  });
  ```

  注：`httpStatus` 显式带 4xx/5xx —— 这些是「框架级问题」，让 HTTP 语义正确便于网关 / CDN 识别。业务错误（A4 / Track A4 自定义）默认 200。

- [ ] **Step 4: i18n 资源**

  `apps/server-agent/i18n/{zh,en}/common.json` + `apps/server-main/i18n/{zh,en}/common.json` 补齐 7 个 key（success / validationFailed / unauthorized / forbidden / notFound / conflict / tooManyRequests / internalError）

- [ ] **Step 5: 单测**

  `libs/common/src/errors/app.error.spec.ts` 覆盖：实例化 / message 传递 / data 透传 / i18nArgs 透传

**Acceptance**:
- `pnpm --filter @meshbot/common build` 全绿
- `pnpm sync:locales --check` 0 missing
- 单测全绿

---

### Task A2: ErrorsFilter（合并 I18nExceptionFilter）

**Files**:
- Create: `libs/common/src/errors/errors.filter.ts`
- Create: `libs/common/src/errors/errors.filter.spec.ts`
- Modify: `libs/common/src/dto/index.ts`（标记 I18nExceptionFilter 为 deprecated，A5 删除）

- [ ] **Step 1: 实现** —— 见 spec §2.2。要点：
  - `@Catch()` 兜底所有 exception
  - `AppError` / `HttpException` / `Error` / unknown 四种分支
  - I18nZodValidationPipe 抛的 `{ errors }` shape 透传到 `data.errors`
  - i18n key 命中点号才尝试翻译，否则原样
  - 注入 `traceId`（取自 `req.traceId`，B2 才落地，A5 留空兜底）

- [ ] **Step 2: 单测** 覆盖：
  - AppError + http 200 + success false + i18n 翻译
  - AppError + httpStatus 401（CommonErrorCode.UNAUTHORIZED）
  - HttpException 包 `{errors:[]}` 透传
  - HttpException 包字符串 i18n key 翻译
  - 普通 Error message 兜底
  - unknown throw 兜底 INTERNAL_ERROR

**Acceptance**:
- 单测全绿
- typecheck 全绿

---

### Task A3: ResponseInterceptor

**Files**:
- Create: `libs/common/src/interceptors/response.interceptor.ts`
- Create: `libs/common/src/interceptors/response.interceptor.spec.ts`
- Create: `libs/common/src/interceptors/index.ts`
- Modify: `libs/common/src/index.ts`

- [ ] **Step 1: 实现** —— 见 spec §2.4。要点：
  - 只包装 controller return（rxjs `map`）
  - 包装 shape 与 ErrorsFilter 对齐（success / code / message / data / timestamp / path / traceId）
  - data 为 undefined 时填 null（避免序列化丢字段）

- [ ] **Step 2: skip 装饰器**（可选，留扩展点）

  ```ts
  export const SKIP_RESPONSE_INTERCEPTOR = Symbol("SKIP_RESPONSE_INTERCEPTOR");
  export const SkipResponseEnvelope = () => SetMetadata(SKIP_RESPONSE_INTERCEPTOR, true);
  ```

  适用：health endpoint / Swagger / 流式 / SSE / OAuth redirect 等不想被包的场景。

- [ ] **Step 3: 单测** 覆盖普通返回 / null / Stream（跳过 wrap，用 SkipResponseEnvelope）

**Acceptance**:
- 单测全绿

---

### Task A4: 迁移既有 throw 到 AppError

**Files**:
- Modify: `libs/main/src/errors/main.error-codes.ts`（改 defineErrorCode 形态，范围 2000-2999）
- Modify: `libs/main/src/services/user.service.ts`（`throwMainError(key)` → `throw new AppError(MainErrorCode.X)`）
- Create: `libs/agent/src/errors/agent.error-codes.ts` 或 `apps/server-agent/src/errors/agent.error-codes.ts`（范围 3000-3999）
- Modify: `apps/server-agent/src/services/auth.service.ts`（既有 `throw new ConflictException(...)` 等 → `throw new AppError(AgentErrorCode.X)`）

- [ ] **Step 1: 重写 main.error-codes.ts**

  ```ts
  export const MainErrorCode = defineErrorCode({
    AUTH_EMAIL_ALREADY_EXISTS: { code: 2001, message: "auth.emailAlreadyExists", httpStatus: 200 },
    AUTH_INVALID_CREDENTIALS:  { code: 2002, message: "auth.invalidCredentials", httpStatus: 200 },
  });
  ```

  删除 `throwMainError` helper（被 `throw new AppError(MainErrorCode.X)` 取代）。

- [ ] **Step 2: 更新 user.service.ts** 把 `throwMainError("emailAlreadyExists")` 换成 `throw new AppError(MainErrorCode.AUTH_EMAIL_ALREADY_EXISTS)`

- [ ] **Step 3: 新建 agent.error-codes.ts**

  ```ts
  export const AgentErrorCode = defineErrorCode({
    AUTH_ALREADY_REGISTERED: { code: 3001, message: "auth.alreadyRegistered", httpStatus: 200 },
    AUTH_INVALID_CREDENTIALS:{ code: 3002, message: "auth.invalidCredentials", httpStatus: 200 },
  });
  ```

- [ ] **Step 4: 更新 auth.service.ts** 把 `ConflictException` / `UnauthorizedException` 换 AppError

**Acceptance**:
- `pnpm --filter @meshbot/main build` 全绿
- `pnpm --filter @meshbot/server-agent build` 全绿
- 既有单测可能 fail（response shape 变化）—— A5 修复

---

### Task A5: 全局注册 + e2e 对齐

**Files**:
- Modify: `apps/server-agent/src/main.ts`
- Modify: `apps/server-main/src/main.ts`
- Modify: `apps/server-main/test/e2e/auth-flow.spec.ts`
- Modify: `apps/server-agent/test/e2e/dto-i18n.spec.ts`（如果还有专门断言 envelope shape 的 case）
- Delete: `libs/common/src/dto/i18n-exception.filter.ts`（被 ErrorsFilter 取代）
- Modify: `libs/common/src/dto/index.ts`

- [ ] **Step 1: 全局注册顺序**（两个 server `main.ts` 一致）

  ```ts
  app.useGlobalPipes(new I18nZodValidationPipe(i18n));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new ErrorsFilter(i18n));
  ```

  顺序解释：filter 最外（捕获 interceptor 链路里抛的错），interceptor 包装成功 envelope，pipe 转 DTO。

- [ ] **Step 2: 删 I18nExceptionFilter**

  从 `libs/common/src/dto/index.ts` 移除导出；删文件。

- [ ] **Step 3: e2e 改断言**

  ```ts
  // 之前
  expect(res.body.message).toBe("邮箱已被注册");
  // 之后
  expect(res.body).toMatchObject({
    success: false,
    code: 2001,
    message: "邮箱已被注册",
  });
  ```

  成功响应也变了：

  ```ts
  expect(res.body).toMatchObject({
    success: true,
    code: 0,
    data: { token: expect.any(String), user: { email: ... } },
  });
  ```

- [ ] **Step 4: typecheck + test + check:strict 全绿**

**Acceptance**:
- 30+ 测试用例适配新 envelope 后全绿
- typecheck 全绿
- 5 围栏全绿

---

### Task E2: check:error-code 静态围栏

**Files**:
- Create: `scripts/check-error-code.ts`
- Modify: `package.json`（加 `check:error-code` script + 写入 `check` / `check:strict` 串联）
- Modify: `.husky/pre-commit`（加入并行 fence 组）

- [ ] **Step 1: 围栏逻辑**

  扫描所有 `defineErrorCode({...})` 调用，提取每个 lib / app 的范围（按文件路径决定，e.g., `libs/common/**` → 1-999；`libs/main/**` → 2000-2999）。校验：

  - `DUPLICATE_CODE`：同 code 出现 ≥ 2 次
  - `OUT_OF_RANGE`：code 在该 lib 不该有的范围
  - `GAP`：(可选) code 跳号（如 2001, 2003，跳过 2002）—— 用 JSDoc `@skip-gap` 豁免

- [ ] **Step 2: package.json**

  ```json
  "check:error-code": "tsx scripts/check-error-code.ts",
  "check": "pnpm check:tx && ... && pnpm check:error-code",
  "check:strict": "... && pnpm check:error-code -- --strict",
  "check:parallel": "pnpm run \"/^check:(tx|naming|lock-tx|repo|dead|error-code)$/\""
  ```

- [ ] **Step 3: 围栏单测**（写 fixture 触发各类 finding）

**Acceptance**:
- `pnpm check:error-code` 0 finding（A4 完成后）
- `pnpm check:error-code -- --strict` 全绿
- pre-commit 全绿 + 时间 ≤ 25s

---

## Track B — Gateway 必备

### Task B1: Page<T> 标准分页

**Files**:
- Create: `libs/types/src/common/page.schema.ts`
- Create: `libs/common/src/dto/page.dto.ts`
- Create: `libs/common/src/dto/page.helper.ts`
- Modify: `libs/types/src/index.ts` / `libs/common/src/index.ts`

- [ ] **Step 1: Zod schema**

  ```ts
  export const PageRequestSchema = z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    size: z.coerce.number().int().min(1).max(100).default(20),
  });
  export type PageRequest = z.infer<typeof PageRequestSchema>;
  ```

- [ ] **Step 2: DTO**

  ```ts
  export class PageRequestDto extends createI18nZodDto(PageRequestSchema) {}
  export interface PageRequestDto extends PageRequest {}

  export interface PageData<T> {
    total: number;
    items: T[];
  }
  ```

- [ ] **Step 3: helper** —— `pageify(items, total)`、Repository → `findPage(qb, opts)` 便利函数

- [ ] **Step 4: 用法示例**（不强制迁移现有 endpoint，仅注释里给一个示范）

**Acceptance**:
- typecheck + 单测全绿

---

### Task B2: Trace ID middleware + 结构化 logger 集成

**Files**:
- Create: `libs/common/src/middlewares/trace-id.middleware.ts`
- Modify: `apps/server-agent/src/main.ts` / `apps/server-main/src/main.ts`（`app.use(traceIdMiddleware)`）
- Modify: `libs/common/src/errors/errors.filter.ts` 与 `libs/common/src/interceptors/response.interceptor.ts`（已在 A 阶段读 `req.traceId`，B2 落实数据来源）

- [ ] **Step 1: middleware**

  ```ts
  export function traceIdMiddleware(req: any, res: any, next: any) {
    const incoming = req.headers["x-trace-id"];
    const traceId = typeof incoming === "string" ? incoming : randomUUID();
    req.traceId = traceId;
    res.setHeader("x-trace-id", traceId);
    next();
  }
  ```

- [ ] **Step 2: 全局注册** 在 server-* `main.ts` 中 `app.use(traceIdMiddleware)`，放在 i18n / pipe 之前

- [ ] **Step 3: 日志带 traceId**（可选）：拓展 NestJS 默认 logger 输出 prefix，或加 `createLoggerWithTrace(req)` helper

**Acceptance**:
- e2e 加 case：发请求带 `x-trace-id: abc-123` → response header `x-trace-id: abc-123` + envelope `traceId: "abc-123"`
- 不带 header → 自动生成 UUID

---

### Task B3: ProxyThrottlerGuard + ThrottlerModule

**Files**:
- Modify: `package.json`（加 `@nestjs/throttler` 依赖；server-agent + server-main 各自加）
- Create: `libs/common/src/guards/proxy-throttler.guard.ts`
- Modify: `apps/server-agent/src/app.module.ts` / `apps/server-main/src/app.module.ts`（注册 ThrottlerModule + 全局 guard）
- Modify: `apps/server-agent/src/services/auth.service.ts` / `apps/server-main/src/rest/auth.controller.ts`（register / login 加 `@Throttle`）

- [ ] **Step 1: 加依赖**

  ```bash
  pnpm --filter @meshbot/server-agent add @nestjs/throttler
  pnpm --filter @meshbot/server-main add @nestjs/throttler
  ```

- [ ] **Step 2: ProxyThrottlerGuard**

  ```ts
  @Injectable()
  export class ProxyThrottlerGuard extends ThrottlerGuard {
    protected getTracker(req: any): Promise<string> {
      const xfwd = req.headers?.["x-forwarded-for"];
      const ip = (typeof xfwd === "string" ? xfwd.split(",")[0].trim() : req.ip) ?? "anon";
      return Promise.resolve(ip);
    }
  }
  ```

- [ ] **Step 3: 注册**（spec §3.2 默认策略）+ 全局 guard

  ```ts
  imports: [
    ThrottlerModule.forRoot([
      { name: "short", ttl: 1000, limit: 30 },
      { name: "medium", ttl: 60_000, limit: 300 },
      { name: "long", ttl: 3_600_000, limit: 5000 },
    ]),
  ],
  providers: [{ provide: APP_GUARD, useClass: ProxyThrottlerGuard }],
  ```

- [ ] **Step 4: 关键端点加严格限流**

  ```ts
  @Public()
  @Post("register")
  @Throttle({ short: { limit: 5, ttl: 60_000 } })  // 1 分钟最多 5 次
  async register(...) { ... }
  ```

- [ ] **Step 5: e2e 用例** —— 连发 6 次 register → 第 6 次 429 + envelope `{success:false, code: 6}`（TOO_MANY_REQUESTS）

**Acceptance**:
- 限流 e2e 单 case 通过
- 全局 guard 不阻碍非装饰端点

---

## Track C — Ops 打磨

### Task C2: PlainTextLogger for TypeORM

**Files**:
- Create: `libs/common/src/utils/plain-text.logger.ts`
- Modify: `apps/server-agent/src/app.module.ts` / `apps/server-main/src/app.module.ts`

- [ ] **Step 1: 实现** TypeORM `Logger` 接口（log / logQuery / logQueryError / logQuerySlow / logSchemaBuild / logMigration）—— 输出 `[QUERY]` / `[SLOW QUERY]` 纯文本

- [ ] **Step 2: 接入** dev 仍用 default colored；production：`logger: new PlainTextLogger()`

**Acceptance**:
- production 模式启动看到无 ANSI 日志

---

### Task C3: DB connection timezone UTC

**Files**:
- Modify: `apps/server-main/src/app.module.ts`

- [ ] **Step 1**：server-main TypeOrmModule.forRootAsync 加 `extra: { options: "-c timezone=UTC" }`
- [ ] **Step 2**：server-agent SQLite 通过 `prepareDatabase` 加 `db.pragma("foreign_keys = OFF")` 已存在；时区无关（SQLite 不存 timestamptz）

**Acceptance**:
- 容器启动连接到 postgres 后 `SHOW timezone;` 返回 `UTC`

---

### Task C1: Terminus health

**Files**:
- Modify: `apps/server-agent/package.json` / `apps/server-main/package.json`（加 `@nestjs/terminus`）
- Create: `libs/common/src/health/redis-health.indicator.ts`
- Modify: `apps/server-agent/src/health.controller.ts` （即 health 路由迁到 Terminus）
- Modify: `apps/server-main/src/health.controller.ts`

- [ ] **Step 1: 加依赖**

  ```bash
  pnpm --filter @meshbot/server-agent add @nestjs/terminus
  pnpm --filter @meshbot/server-main add @nestjs/terminus
  ```

- [ ] **Step 2: RedisHealthIndicator**

  ```ts
  @Injectable()
  export class RedisHealthIndicator extends HealthIndicator {
    constructor(@Inject(LOCK_PROVIDER) private lock: LockProvider) {}
    async ping(): Promise<HealthIndicatorResult> {
      // 通过获取 + 立即释放一个临时锁，验证 redis / memory 都活着
      try {
        const release = await this.lock.acquire("health:ping", 1000, 0);
        await release();
        return this.getStatus("redis", true);
      } catch (e) {
        throw new HealthCheckError("redis down", this.getStatus("redis", false));
      }
    }
  }
  ```

- [ ] **Step 3: HealthController**

  ```ts
  @Controller("health")
  @Public()
  @SkipResponseEnvelope()
  export class HealthController {
    constructor(
      private health: HealthCheckService,
      private db: TypeOrmHealthIndicator,
      private redis: RedisHealthIndicator,
    ) {}
    @Get()
    @HealthCheck()
    check() {
      return this.health.check([
        () => this.db.pingCheck("database"),
        () => this.redis.ping(),  // server-main 才有；server-agent 跳过
      ]);
    }
  }
  ```

- [ ] **Step 4: e2e** —— health endpoint 返回 `{status:"ok", info:{database:{status:"up"}, redis:{status:"up"}}}`

**Acceptance**:
- e2e 通过
- DB 断开时 health 返回 503 + 标记哪个组件 down

---

### Task C4: Swagger 安全方案

**Files**:
- Create: `apps/server-main/src/app.swagger.ts`
- Create: `apps/server-agent/src/app.swagger.ts`
- Modify: 两个 `main.ts`（dev 模式注册 Swagger UI）

- [ ] **Step 1: SwaggerModule 配置**

  ```ts
  const config = new DocumentBuilder()
    .setTitle("meshbot server-main API")
    .setVersion("0.0.1")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" }, "jwt-main")
    .addSecurityRequirements("jwt-main")
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, doc);
  ```

- [ ] **Step 2: dev only**

  ```ts
  if (process.env.NODE_ENV !== "production") setupSwagger(app);
  ```

- [ ] **Step 3: 几个 controller 加 `@ApiTags("auth")` / `@ApiOperation(...)`** —— 至少 register / login 端点带完整描述（已部分有）

**Acceptance**:
- `pnpm dev:server-main` 启后 `http://localhost:3200/api/docs` 可访问
- Bearer 认证按钮可点开输入 token

---

## Track D — Snowflake ID

### Task D1: @SnowflakeId 装饰器

**Files**:
- Create: `libs/common/src/decorators/snowflake-id.decorator.ts`
- Create: `libs/common/src/decorators/snowflake-id.decorator.spec.ts`
- Modify: `libs/common/src/decorators/index.ts`

- [ ] **Step 1: 实现 Snowflake 生成器**

  ```ts
  class SnowflakeIdGenerator {
    private lastTime = -1n;
    private seq = 0n;
    private readonly nodeId: bigint;
    constructor(nodeId = Number(process.env.MESHBOT_NODE_ID ?? 0)) {
      this.nodeId = BigInt(nodeId) & 0x3ffn; // 10 bit
    }
    next(): string {
      let now = BigInt(Date.now());
      if (now <= this.lastTime) {
        this.seq = (this.seq + 1n) & 0xfffn;
        if (this.seq === 0n) {
          while (now <= this.lastTime) now = BigInt(Date.now());
        }
      } else {
        this.seq = 0n;
      }
      this.lastTime = now;
      const id = ((now - 1700000000000n) << 22n) | (this.nodeId << 12n) | this.seq;
      return id.toString();
    }
  }
  const singleton = new SnowflakeIdGenerator();
  export function generateSnowflakeId(): string { return singleton.next(); }
  ```

- [ ] **Step 2: 装饰器**

  ```ts
  export function SnowflakeId(): PropertyDecorator {
    return (target, propertyKey) => {
      PrimaryColumn({ type: "varchar", length: 20 })(target, propertyKey);
      BeforeInsert()((target as any).constructor.prototype, "generateIdBeforeInsert");
      Object.defineProperty((target as any).constructor.prototype, "generateIdBeforeInsert", {
        configurable: true,
        value() { if (!this[propertyKey]) this[propertyKey] = generateSnowflakeId(); },
      });
    };
  }
  ```

- [ ] **Step 3: 单测**：并发生成不冲突 / 时间回拨容忍 / 跨进程（nodeId 不同）不冲突

**Acceptance**:
- 1000 次并发 generate 全唯一
- 单测全绿

---

### Task D2: UUID vs Snowflake 约定文档

**Files**:
- Modify: `.cursor/rules/shared-data-model.mdc`
- 同步：`pnpm sync:skills`

- [ ] **Step 1**：rule 中增加节「主键策略」：
  - **UUID** 用于：本地单进程实体（server-agent 全部）、不可猜测 token（refresh token / invite token 等）
  - **Snowflake** 用于：server-main 业务实体（多实例可能并发插入）、需要时间排序的实体（消息 / 事件 / 日志）

**Acceptance**:
- `pnpm sync:skills --check` 通过
- rule 文档在 `.cursor` 与 `.claude/skills` 同步

---

## Track E — 软删除规范

### Task E1: 软删除模式 + skill rule

**Files**:
- Modify: `.cursor/rules/service-repo-access.mdc`（或 `migrations-ddl.mdc`）
- 同步：`pnpm sync:skills`

- [ ] **Step 1**：rule 中增加「软删除模式」节，覆盖：
  - 字段：`@DeleteDateColumn({ type: "timestamptz", nullable: true }) deletedAt!: Date | null`
  - 唯一约束加部分索引：`@Index([...], { where: '"deleted_at" IS NULL' })`
  - Service：默认查询自动过滤已删；带 `withDeleted: true` 时查全量
  - 不做 ORM cascade，每个 Service 自己管子实体软删

- [ ] **Step 2**：在 `.cursor/rules/migrations-ddl.mdc` 加：
  - 软删迁移：`ALTER TABLE x ADD COLUMN deleted_at TIMESTAMPTZ NULL`
  - 转换部分唯一索引：`DROP INDEX old_unique; CREATE UNIQUE INDEX new_unique ON x(...) WHERE deleted_at IS NULL;`

**Acceptance**:
- `pnpm sync:skills --check` 通过

---

## Phase 5 完工验收

```bash
pnpm typecheck                       # 全包
pnpm check:strict                    # 6 围栏（含 check:error-code）
pnpm sync:skills -- --check
pnpm sync:locales -- --check
pnpm test                            # 全套含新 envelope 断言
pnpm build

pnpm dev:db:up
pnpm migration:run:main
pnpm dev:server-main
curl -i http://localhost:3200/api/health      # 200 + Terminus 分组
curl -i http://localhost:3200/api/docs        # Swagger UI
curl -i http://localhost:3200/api/auth/register -d '{}' -H 'content-type: application/json'
# 期望 envelope：{success:false, code:1, message:"通用校验失败", data:{errors:[...]}, traceId:..., timestamp:...}
for i in {1..6}; do curl -s -X POST .../register -d ...; done  # 第 6 次 429
```

更新 `.claude/CLAUDE.md` + `docs/PHASE_HISTORY.md` 标记 Phase 5 ✅。

---

## 风险监控（执行期）

| 风险 | 缓解 |
|---|---|
| A5 同步改 e2e 断言量大 | 用 `toMatchObject` 而非 `toEqual` 局部断言 |
| ResponseInterceptor 包 health endpoint 破坏 Terminus shape | C1 health controller 加 `@SkipResponseEnvelope()` |
| Snowflake `MESHBOT_NODE_ID` 不同节点忘配冲突 | env 缺失时默认 0；多实例文档化 |
| ThrottlerModule memory storage 多实例不一致 | 文档化「Phase 6 切 Redis storage」；Phase 5 仍可 best-effort 单实例使用 |

---

## 下一步

逐 task 执行：A1 → A2 → A3 → A4 → A5 → E2 → B1 → B2 → B3 → C2 → C3 → C1 → C4 → D1 → D2 → E1。
每 track 完成单独 commit。
