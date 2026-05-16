# meshbot Phase 5：框架抽屉补全（借鉴  框架细节）

- 日期：2026-05-16
- 范围：在 Phase 1-4 的基础上补齐 NestJS 框架级基建（错误码 / 统一响应 / 分页 / Trace ID / 限流 / Health / Logger / Swagger / Snowflake / 软删除）
- 形态：一份 spec，5 个 track，~15 task
- 不含：监控（Sentry / OTel，用户明确推迟）；业务模型（meshbot 自行迭代）；BullMQ 队列（按需，未来再引入）

---

## 1. 总体目标与范围

### 1.1 目标

把 server-agent / server-main 从「能跑通 + 能交付」推到「具备生产级 NestJS 服务标准基建」：
- 错误处理：结构化错误码 + 统一响应 envelope，前端有稳定判断面
- 可观测性：Trace ID 贯穿请求 + TypeORM 纯文本日志 + 分级 Health Check
- 防护：proxy-aware 限流 + 软删除模式 + ID 生成抽象
- 文档：Swagger 安全方案 + 多文档区分（内部 / 公开 API）

### 1.2 一套基建两端共用

server-agent 与 server-main 同为 NestJS 11 服务，所有 Phase 5 引入的全局
filter / interceptor / middleware / guard / pipe 都在两端注册。差异：
- server-agent：单进程 / 本地 / 高 Agent core 负载 —— 限流可松、Health 只查 SQLite
- server-main：高并发 / 多实例 / Gateway —— 限流严、Health 查 Postgres + Redis、Trace ID 必须贯穿

### 1.3 五条 track

| Track | 主题 | task |
|---|---|---|
| **A** | 错误 + 响应基石（AppError / ErrorCode / Filter / Interceptor / 围栏 / 迁移） | 6 |
| **B** | Gateway 必备（Page / TraceId / Throttler） | 3 |
| **C** | Ops 打磨（Health / Logger / timezone / Swagger） | 4 |
| **D** | Snowflake ID（装饰器 + 约定） | 2 |
| **E** | 软删除规范 | 1 |

合计 **16 task**（A 拆出 E2 共 6，故 6+3+4+2+1=16；表格按 "Track A 6 task"）。

### 1.4 不做什么

- ❌ **监控**（Sentry / OTel / Grafana）—— 用户明确推迟
- ❌ **业务模型**（cli-agent 维护接口 / 多 agent 协同业务逻辑）—— meshbot 自定义
- ❌ **BullMQ / 队列抽象** —— 真有异步任务时再引入
- ❌ **Idempotency-Key 中间件** —— 真有重试场景再加
- ❌ **Nacos / YAML config loader** —— dotenv + @nestjs/config 够用
- ❌ **RBAC `@RequirePermission`** —— meshbot 业务模型决定后再设计

### 1.5 退出标志

- 所有 `throw new ...` 在 libs/main / apps/server-* 走 `throw new AppError(ErrorCode.X)` 链路
- 所有 controller 响应（成功 + 失败）形态 `{success, code, message, data, timestamp, path}` 统一
- `pnpm check:error-code` 0 finding，纳入 `pnpm check` 一键跑
- server-* 端点支持 Trace ID（`x-trace-id` request → response + log）
- 关键接口（register / login 等写入端点）`@Throttle()` 生效
- `/api/health` 返回 `{status, details: { database, redis }}` 分组结果
- `/api/docs` Swagger UI 可访问，带 Bearer 安全方案
- TypeORM 日志输出纯文本（无 ANSI）+ 标记 `[SLOW QUERY]`（>500ms）
- DB 连接固定 `timezone=UTC`
- `@SnowflakeId` 装饰器可用 + 文档区分 UUID / Snowflake 使用场景
- 软删除规范（`@DeleteDateColumn` + 部分唯一索引）写入 `service-repo-access` 或新 skill
- `pnpm typecheck` / `pnpm test` / `pnpm check:strict` / `pnpm sync:locales --check` / `pnpm sync:skills --check` 全绿
- CLAUDE.md 标记 Phase 5 ✅，`docs/PHASE_HISTORY.md` 同步追加

---

## 2. Track A — 错误 + 响应基石（6 task）

### 2.1 AppError 类型设计

```ts
// libs/common/src/errors/error-code.ts
export interface ErrorCode {
  /** 全局唯一数字编号（范围按 lib 划分，见 §2.3） */
  code: number;
  /** 默认 i18n key（fallback 时直接当 message）*/
  message: string;
  /** HTTP 状态码，默认 200（业务错误不污染 HTTP 语义；4xx 留给框架级问题） */
  httpStatus?: number;
}

export function defineErrorCode<T extends Record<string, ErrorCode>>(codes: T): T {
  // 仅做编译期类型 alias；运行期数据原样返回。
  return codes;
}
```

```ts
// libs/common/src/errors/app.error.ts
export class AppError extends Error {
  constructor(
    public readonly errorCode: ErrorCode,
    public readonly data: unknown = null,
    public readonly i18nArgs: Record<string, unknown> = {},
  ) {
    super(errorCode.message);
  }
}
```

### 2.2 ErrorsFilter（合并 Phase 3 的 I18nExceptionFilter）

```ts
// libs/common/src/errors/errors.filter.ts
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  constructor(private readonly i18n: I18nService) {}
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();
    const lang = I18nContext.current()?.lang ?? "zh";

    let httpStatus = 200;
    let code = -1;
    let message = "Internal Server Error";
    let data: unknown = null;

    if (exception instanceof AppError) {
      code = exception.errorCode.code;
      httpStatus = exception.errorCode.httpStatus ?? 200;
      message = this.tryI18n(exception.errorCode.message, lang, exception.i18nArgs);
      data = exception.data;
    } else if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      const raw = exception.getResponse() as any;
      // I18nZodValidationPipe 抛的 BadRequest 形态 `{ errors: [...] }`
      if (typeof raw === "object" && Array.isArray(raw.errors)) {
        code = CommonErrorCode.VALIDATION_FAILED.code;
        message = this.tryI18n(CommonErrorCode.VALIDATION_FAILED.message, lang);
        data = { errors: raw.errors };
      } else {
        const rawMessage = typeof raw === "string" ? raw : raw.message;
        code = -1;
        message = this.tryI18n(rawMessage, lang);
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    res.status(httpStatus).json({
      success: code === 0,
      code,
      message,
      data,
      timestamp: new Date().toISOString(),
      path: req.url,
      traceId: req.traceId,  // 由 TraceIdMiddleware 注入
    });
  }
}
```

### 2.3 ErrorCode 范围划分

| Lib / App | 范围 | 用途 |
|---|---|---|
| `libs/common` | `0` | success 哨兵 |
| `libs/common` | `1-999` | 框架级（VALIDATION_FAILED / UNAUTHORIZED / INTERNAL_ERROR / TOO_MANY_REQUESTS 等） |
| `libs/main` | `2000-2999` | server-main 业务（AUTH_*、ORG_* 等，留给 meshbot 自定义） |
| `libs/agent` | `3000-3999` | server-agent 业务（SETUP_*、AGENT_*） |
| **预留** | `4000+` | 未来新 lib |

`check:error-code` 围栏校验：每个 lib 内 code 递增不跳号、不重复、不越界。

### 2.4 ResponseInterceptor

```ts
// libs/common/src/interceptors/response.interceptor.ts
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest();
    return next.handle().pipe(
      map((data) => ({
        success: true,
        code: 0,
        message: "success",
        data: data ?? null,
        timestamp: new Date().toISOString(),
        path: req.url,
        traceId: req.traceId,
      })),
    );
  }
}
```

注：response shape 完全对齐 ErrorsFilter，便于前端单一 unwrap 逻辑。

### 2.5 任务清单

- **A1** AppError + defineErrorCode + ErrorCode 注册（`libs/common/src/errors/`）+ `CommonErrorCode`（VALIDATION_FAILED / UNAUTHORIZED / FORBIDDEN / NOT_FOUND / INTERNAL_ERROR / TOO_MANY_REQUESTS）
- **A2** ErrorsFilter 实现 + 合并 / 替换 Phase 3 `I18nExceptionFilter`
- **A3** ResponseInterceptor 实现 + 单测
- **A4** 迁移既有 throw：
  - `libs/main/src/errors/main.error-codes.ts` → 改为 `defineErrorCode` 形态（范围 2000-2999）
  - `apps/server-agent/src/services/auth.service.ts` 等 → `throw new AppError(AgentErrorCode.X)`
  - `libs/main/src/services/user.service.ts` `throwMainError` 调用点
- **A5** 全局注册（server-agent / server-main `main.ts`）：
  - `useGlobalPipes(I18nZodValidationPipe)`（保留）
  - `useGlobalInterceptors(ResponseInterceptor)`（新）
  - `useGlobalFilters(ErrorsFilter)`（新；替换 I18nExceptionFilter）
  - 修复 e2e 断言（响应 shape 变了）
- **E2** `scripts/check-error-code.ts` 静态围栏 + 写入 `pnpm check` + 写入 husky pre-commit

---

## 3. Track B — Gateway 必备（3 task）

### 3.1 任务清单

- **B1** `libs/types/src/common/page.schema.ts`（PageRequestSchema 强转 page/size）+ `libs/common/src/dto/page.dto.ts`（`PageDataDto<T>` + helper）+ `libs/common/src/swagger/page.helper.ts`（自动注册 swagger schema）
- **B2** TraceIdMiddleware：`x-trace-id` request header 透传，缺失则 `randomUUID()`；写入 `req.traceId` + response header + 日志 prefix；server-agent / server-main `main.ts` `app.use(traceIdMiddleware)`
- **B3** `libs/common/src/guards/proxy-throttler.guard.ts`（基于 `@nestjs/throttler`，覆盖 `getTracker` 走 `x-forwarded-for`）+ server-main / server-agent 注册 ThrottlerModule + 在 register / login 等关键端点加 `@Throttle({ short: { limit: 5, ttl: 60000 } })`

### 3.2 Throttle 默认策略

```ts
ThrottlerModule.forRoot({
  throttlers: [
    { name: "short", ttl: 1000, limit: 30 },    // 1s 内 30 次
    { name: "medium", ttl: 60_000, limit: 300 }, // 1min 内 300 次
    { name: "long", ttl: 3_600_000, limit: 5000 },// 1h 内 5000 次
  ],
  storage: ...,  // server-main: 用 Redis；server-agent: memory
})
```

> Phase 5 不引入 Redis storage（默认 memory，单实例够用）；server-main 多实例时再换 `@nest-lab/throttler-storage-redis`，Phase 6。

---

## 4. Track C — Ops 打磨（4 task）

### 4.1 任务清单

- **C1** `@nestjs/terminus` 接入：`/api/health` 返回 `{status, info: { database: {status}, redis: {status} }}`；server-agent 仅 `database`；server-main 加 `redis`（按 REDIS_URL 是否设置决定是否查）
- **C2** `libs/common/src/utils/plain-text.logger.ts`（实现 TypeORM `Logger` 接口）+ server-* TypeORM forRoot 接入 `logger: new PlainTextLogger()`，dev 仍用 NestJS 默认 colored
- **C3** server-agent / server-main TypeORM forRoot 加 `extra: { options: "-c timezone=UTC" }`（server-main Postgres）+ SQLite 通过 `prepareDatabase` pragma 已经 ok
- **C4** Swagger 安全方案：`addBearerAuth`、`addApiKey`（agent 用）、`addSecurityRequirements`；server-main `/api/docs`、server-agent `/api/docs`（dev only）；可选「内部 / 公开」按 tag 分文档

---

## 5. Track D — Snowflake ID（2 task）

### 5.1 任务清单

- **D1** `libs/common/src/decorators/snowflake-id.decorator.ts`：基于 Twitter Snowflake 算法（41 bit 时间戳 + 5 bit datacenter + 5 bit worker + 12 bit seq），从 env 读 `MESHBOT_NODE_ID`；BeforeInsert hook 给 `@PrimaryColumn` 生成 id 字符串
- **D2** 写入 `.cursor/rules/shared-data-model.mdc`（或新 skill）：
  - **UUID** 用于：本地单进程实体（server-agent SQLite User / Setting / ModelConfig）、对外暴露的随机不可猜测 token
  - **Snowflake** 用于：server-main 多实例可能并发插入的实体（未来业务模型）；时间排序友好；ID 比 UUID 短一半（19 位数字 vs 36 字符 UUID）

### 5.2 不做

- 不做 ID 类型迁移 —— 现有 AppUser 仍 UUID。Snowflake 留给新业务实体选用。

---

## 6. Track E — 软删除规范（1 task）

### 6.1 任务清单

- **E1** 在 `.cursor/rules/migrations-ddl.mdc` 或 `.cursor/rules/service-repo-access.mdc` 增加「软删除模式」节：
  - 用 `@DeleteDateColumn({ type: "timestamptz", nullable: true })`（field 名 `deletedAt`）
  - 涉及唯一约束的字段加部分唯一索引：`@Index([...], { where: '"deleted_at" IS NULL' })`
  - Service 层默认走 `find` / `findOne`（TypeORM 自动过滤 deletedAt IS NULL）；要查含软删的用 `findWithDeleted`
  - 不做 ORM 级 cascade 软删，每个 Service 显式处理子实体
- 当前 4 个 entity（AppUser / User / Setting / ModelConfig）暂不加软删；规范文档化，新 entity 按需用

---

## 7. 风险 / 未决 / Phase 6 衔接

### 7.1 已知风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | Response envelope 改动破坏前端 / e2e 断言 | A5 同步改 e2e；前端（web-agent / web-main）适配 unwrap 工具函数（短期 hardcode unwrap，长期 fetch helper） |
| R2 | AppError httpStatus 默认 200 与现有约定矛盾 | 文档化：业务错误 200 + `success:false`；4xx/5xx 留给框架级；前端按 `success` 字段判断 |
| R3 | Throttler memory storage 多实例不一致 | Phase 6 切 Redis storage（已经有 RedisProvider 抽象，加 storage 适配即可） |
| R4 | check:error-code 围栏对现有 throwMainError 不兼容 | A4 完成迁移后再开 strict |
| R5 | Snowflake datacenter/worker ID 冲突 | env `MESHBOT_NODE_ID` 默认 0；多实例部署文档化要求各节点设不同值 |
| R6 | TypeORM PlainTextLogger 与 NestJS Logger 重复输出 | 仅在 production 启用；dev 保留 NestJS 默认便于调试 |

### 7.2 未决问题

- Q1：AppError 的 `data` 字段是否允许包含 stack trace（仅 dev） → 默认不带；dev 模式由 ErrorsFilter 加 `errorStack` 字段
- Q2：trace ID 是否对接 OTel propagation 标准（`traceparent` header）→ Phase 5 用 `x-trace-id` 自定义 header；Phase 6 接 OTel 时迁到 `traceparent`
- Q3：Snowflake worker ID 是否自动从 hostname hash → Phase 5 强制 env；自动派生 Phase 6 可选

### 7.3 Phase 6 衔接候选

- **监控**：Sentry / OTel 接入（trace ID 已就位，OTel propagation 切换轻量）
- **Throttler Redis storage**：多实例限流准确
- **业务模型**：meshbot 自行迭代云端协同业务
- **k8s / Helm**：多机部署
- **TTL 续期 watchdog**：长任务持锁

---

## 8. 下一步

本 spec 通过后写实施 plan，按 §1.3 顺序执行：A1 → A2 → A3 → A4 → A5 → E2 → B1 → B2 → B3 → C2 → C3 → C1 → C4 → D1 → D2 → E1。

每 track 完成后单独 commit。
