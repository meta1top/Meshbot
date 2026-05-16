# meshbot Phase 6 实施 Plan — 多实例正确性 + 启动期约束 + WebSocket 框架预备

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans

- **Spec**: [2026-05-17-meshbot-phase-6-design.md](../specs/2026-05-17-meshbot-phase-6-design.md)
- **Date**: 2026-05-17
- **Goal**: server-main 多实例正确 + 启动期 fail-fast + WebSocket 骨架

---

## 依赖图

```
A1（Throttler Redis storage，独立）
C1（Snowflake auto NODE_ID）─→ 可独立完成
C2（env-schema helper）─→ C3（两个 server 接入）
B1（WithLockOptions watchdog flag）─→ B2（RedisLock 实现）─→ B3（单测）
D1（ws 基建）─→ D2（traceId）─→ D3（health gateway + e2e）
```

**推荐顺序**：A1 → C1 → C2 → C3 → B1 → B2 → B3 → D1 → D2 → D3

---

## Track A — Throttler Redis storage

### Task A1: 接入 `@nest-lab/throttler-storage-redis`

**Files**:
- Modify: `apps/server-main/package.json`（加 dep）
- Modify: `apps/server-main/src/app.module.ts`（ThrottlerModule 改 forRootAsync）

- [ ] **Step 1: 加依赖**

  ```bash
  pnpm --filter @meshbot/server-main add @nest-lab/throttler-storage-redis
  ```

- [ ] **Step 2: 共享 Redis 实例**

  当前 AppModule 在 `CommonModule.forRootAsync` 里 `new Redis(redisUrl)` 一次性创建。需要拎到模块顶层供 ThrottlerModule 复用。重构方案：

  ```ts
  // 在 AppModule.imports 之前提取
  const REDIS_CLIENT = Symbol("REDIS_CLIENT");

  {
    provide: REDIS_CLIENT,
    inject: [ConfigService],
    useFactory: (cfg: ConfigService) => {
      const url = cfg.get<string>("REDIS_URL");
      return url ? new Redis(url, { maxRetriesPerRequest: 3 }) : null;
    },
  }
  ```

  然后 `CommonModule.forRootAsync` 和 `ThrottlerModule.forRootAsync` 都 inject `REDIS_CLIENT`。

- [ ] **Step 3: ThrottlerModule.forRootAsync**

  ```ts
  ThrottlerModule.forRootAsync({
    inject: [REDIS_CLIENT],
    useFactory: (redis: Redis | null): ThrottlerModuleOptions => ({
      throttlers: [
        { name: "short", ttl: 1000, limit: 30 },
        { name: "medium", ttl: 60_000, limit: 300 },
        { name: "long", ttl: 3_600_000, limit: 5000 },
      ],
      ...(redis ? { storage: new ThrottlerStorageRedisService(redis) } : {}),
    }),
  }),
  ```

- [ ] **Step 4: 冒烟验证**

  起 server-main 两副本（同 REDIS_URL 不同 PORT）；用 `for i in {1..40}` curl /api/auth/register 同 IP；第 31 次起两个副本都应返回 429（共享计数 ≤ 30/s）。

**Acceptance**：
- `pnpm typecheck` 全绿
- `pnpm test` 不退化（限流默认 storage 不在 e2e 触发，因 e2e 不导入 ThrottlerModule）

---

## Track C — Snowflake auto NODE_ID + Zod env

### Task C1: Snowflake `deriveNodeIdFromHostname()`

**Files**:
- Modify: `libs/common/src/utils/snowflake.ts`
- Modify: `libs/common/src/utils/snowflake.spec.ts`

- [ ] **Step 1: 加 FNV-1a hash + 优先级派生**

  ```ts
  function fnv1aHash(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  export function deriveNodeId(): number {
    const explicit = process.env.MESHBOT_NODE_ID;
    if (explicit !== undefined && explicit !== "") {
      return Number(explicit);
    }
    return fnv1aHash(hostname()) & 0x3ff;
  }
  ```

- [ ] **Step 2: SnowflakeIdGenerator 构造函数默认走 deriveNodeId**

  保留显式 nodeId 入参（单测用）；默认 `new SnowflakeIdGenerator()` 自动派生。

- [ ] **Step 3: 单测**

  - 给定 hostname → 固定 nodeId（mock `os.hostname`）
  - MESHBOT_NODE_ID env 覆盖 hostname
  - 不同 hostname → nodeId 通常不同（probabilistic，但 sample 测试）

**Acceptance**：单测全绿。

---

### Task C2: env-schema helper

**Files**:
- Create: `libs/common/src/config/env-schema.ts`
- Modify: `libs/common/src/index.ts`

- [ ] **Step 1: 工厂函数**

  ```ts
  import type { ZodTypeAny, z } from "zod";

  export function createEnvValidator<T extends ZodTypeAny>(schema: T) {
    return (env: Record<string, unknown>): z.infer<T> => {
      const parsed = schema.safeParse(env);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        throw new Error(
          `[env-schema] 环境变量校验失败：\n${issues}\n` +
            `请检查 .env.* 或部署环境变量。`,
        );
      }
      return parsed.data;
    };
  }
  ```

- [ ] **Step 2: 导出**

  `libs/common/src/index.ts` 加 `export * from "./config";` + 建 `config/index.ts`。

- [ ] **Step 3: 单测**

  - 合法 env → 返回 parsed
  - 缺必填 → 抛错 message 包含字段路径
  - 不合法 URL → 同上

**Acceptance**：单测全绿。

---

### Task C3: 两个 server 接入 env.schema.ts

**Files**:
- Create: `apps/server-main/src/env.schema.ts`
- Create: `apps/server-agent/src/env.schema.ts`
- Modify: 两个 `src/app.module.ts` （`ConfigModule.forRoot({ validate })`）

- [ ] **Step 1: server-main env schema**

  ```ts
  import { z } from "zod";

  export const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3200),
    DATABASE_URL: z.string().url().startsWith("postgresql://"),
    JWT_SECRET: z.string().min(16, "JWT_SECRET 至少 16 字符（生产建议 32 字节随机串）"),
    JWT_EXPIRES: z.string().regex(/^\d+[smhd]$/, "格式如 7d / 12h / 60m").default("7d"),
    REDIS_URL: z.string().url().startsWith("redis").optional(),
    MESHBOT_NODE_ID: z.coerce.number().int().min(0).max(1023).optional(),
  });
  export type Env = z.infer<typeof EnvSchema>;
  ```

- [ ] **Step 2: server-agent env schema**

  ```ts
  import { z } from "zod";

  export const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    MESHBOT_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    MESHBOT_HOME: z.string().optional(),
    // 本地 Agent 无强依赖 DB env（SQLite 走 prepareDatabase）
  });
  export type Env = z.infer<typeof EnvSchema>;
  ```

- [ ] **Step 3: 接入 ConfigModule**

  ```ts
  ConfigModule.forRoot({
    isGlobal: true,
    envFilePath: [".env.development", ".env"],
    validate: createEnvValidator(EnvSchema),
  });
  ```

- [ ] **Step 4: 冒烟验证**

  - 删 `.env.development` 起 server-main → exit 1 + 报错列出缺失字段
  - JWT_SECRET 设为 5 字符 → exit 1 + 报错指出长度不够

**Acceptance**：
- typecheck 全绿
- e2e 测试 mock 期间能跑（test 模式 + ConfigModule.forRoot 的 load factory 注入会绕过 validate？需要在测试里要么传完整 env，要么用 `ignoreEnvFile: true`）
- 手测两条 fail-fast 路径

---

## Track B — RedisLock TTL watchdog

### Task B1: WithLockOptions 加 watchdog 字段

**Files**:
- Modify: `libs/common/src/decorators/with-lock.decorator.ts`
- Modify: `libs/common/src/lock/lock.provider.ts`（接口扩展可选 watchdog 选项）

- [ ] **Step 1: 接口扩展**

  ```ts
  // with-lock.decorator.ts
  export interface WithLockOptions {
    key: string;
    ttl?: number;
    waitTimeout?: number;
    errorMessage?: string;
    /** 启用 watchdog 自动续期，默认 false。仅 RedisLockProvider 生效，Memory 模式忽略 */
    watchdog?: boolean;
    /** 续期间隔（ms），默认 ttl/3 */
    renewIntervalMs?: number;
  }
  ```

- [ ] **Step 2: LockProvider 接口扩展**

  ```ts
  export interface AcquireOptions {
    /** 启用 watchdog 自动续期；如 true 由 provider 接管定时器 */
    watchdog?: boolean;
    /** 续期间隔（ms），默认 ttlMs/3 */
    renewIntervalMs?: number;
  }
  export interface LockProvider {
    acquire(
      key: string,
      ttlMs: number,
      waitMs: number,
      options?: AcquireOptions,
    ): Promise<LockRelease>;
  }
  ```

- [ ] **Step 3: 装饰器透传**

  ```ts
  const release = await provider.acquire(lockKey, ttl, waitTimeout, {
    watchdog: options.watchdog,
    renewIntervalMs: options.renewIntervalMs ?? Math.floor(ttl / 3),
  });
  ```

**Acceptance**：接口扩展不破坏现有 caller（参数可选）。

---

### Task B2: RedisLockProvider watchdog 实现

**Files**:
- Modify: `libs/common/src/lock/redis-lock.provider.ts`
- Modify: `libs/common/src/lock/memory-lock.provider.ts`（兼容签名 + no-op）

- [ ] **Step 1: Redis 实现**

  ```ts
  const RENEW_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
  `;

  async acquire(key, ttlMs, waitMs, opts?: AcquireOptions): Promise<LockRelease> {
    // ...既有 SET NX PX 循环...
    let timer: NodeJS.Timeout | null = null;
    if (opts?.watchdog) {
      const renewMs = opts.renewIntervalMs ?? Math.floor(ttlMs / 3);
      timer = setInterval(async () => {
        try {
          const ok = await this.redis.eval(RENEW_SCRIPT, 1, key, token, ttlMs);
          if (ok === 0) {
            // 锁已被他人持有，停掉自己 watchdog（不抛错）
            if (timer) clearInterval(timer);
            timer = null;
            this.logger.warn(
              `[watchdog] lock ${key} no longer held by us, stopping renew`,
            );
          }
        } catch (e) {
          // Redis 短暂故障，下一轮重试；致命错误任由 setInterval 上抛
          this.logger.warn(`[watchdog] renew error: ${e}`);
        }
      }, renewMs);
      timer.unref?.(); // 不阻塞进程退出
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    };
  }
  ```

  注：需在 class 加 `private readonly logger = new Logger(RedisLockProvider.name);`

- [ ] **Step 2: Memory no-op**

  ```ts
  async acquire(key, ttlMs, waitMs, _opts?: AcquireOptions): Promise<LockRelease> {
    // watchdog 在 memory 模式无意义（单进程无 TTL 失效）；忽略
    // ...既有 async-mutex 逻辑...
  }
  ```

**Acceptance**：build clean，既有单测全绿。

---

### Task B3: watchdog 单测

**Files**:
- Modify: `libs/common/src/lock/redis-lock.provider.spec.ts`

- [ ] **Step 1: 长任务不丢锁**

  ```ts
  it("watchdog 持续续期，业务超 ttl 仍持有锁", async () => {
    const { provider, redis } = makeProvider();
    const release = await provider.acquire("k:long", 200, 0, {
      watchdog: true,
      renewIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 350)); // 超 ttl 175%
    // 检查 key 仍在
    expect(await redis.get("k:long")).not.toBeNull();
    await release();
    expect(await redis.get("k:long")).toBeNull();
  });
  ```

- [ ] **Step 2: release 后 watchdog 停**

  ```ts
  it("release 后 watchdog 定时器停止", async () => {
    const { provider, redis } = makeProvider();
    const release = await provider.acquire("k:stop", 1000, 0, {
      watchdog: true,
      renewIntervalMs: 50,
    });
    await release();
    expect(await redis.get("k:stop")).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    // 不应抛错或自动重建 key
    expect(await redis.get("k:stop")).toBeNull();
  });
  ```

- [ ] **Step 3: token 不匹配静默停止**

  ```ts
  it("续期 token 不匹配 → watchdog 静默停（不抛错）", async () => {
    const { provider, redis } = makeProvider();
    const release = await provider.acquire("k:race", 200, 0, {
      watchdog: true,
      renewIntervalMs: 50,
    });
    // 模拟其他实例抢占：直接覆盖 key
    await redis.set("k:race", "other-token", "PX", 1000);
    await new Promise((r) => setTimeout(r, 150));
    // release 应该幂等不抛错
    await release();
    // key 仍是 other-token
    expect(await redis.get("k:race")).toBe("other-token");
  });
  ```

**Acceptance**：3 个新 case 全绿。

---

## Track D — WebSocket Gateway 框架

### Task D1: WS 基建（auth guard + exception filter）

**Files**:
- Create: `libs/common/src/ws/ws-auth.guard.ts`
- Create: `libs/common/src/ws/ws-exception.filter.ts`
- Create: `libs/common/src/ws/index.ts`
- Modify: `libs/common/src/index.ts`
- Modify: `libs/common/package.json`（peer dep `@nestjs/websockets` + `@nestjs/platform-socket.io` + `socket.io`）

- [ ] **Step 1: WsAuthGuard**

  ```ts
  // 不直接依赖 JwtService（避免循环 peer），而是从 client.data.user 读
  // 实际 JWT verify 由 ws-jwt.middleware（D2 部分）处理
  @Injectable()
  export class WsAuthGuard implements CanActivate {
    canActivate(ctx: ExecutionContext): boolean {
      const client = ctx.switchToWs().getClient<Socket>();
      if (!client.data?.user) {
        throw new WsException(
          new AppError(CommonErrorCode.UNAUTHORIZED),
        );
      }
      return true;
    }
  }
  ```

- [ ] **Step 2: WsExceptionFilter**

  ```ts
  @Catch()
  export class WsExceptionFilter implements ExceptionFilter {
    constructor(private readonly i18n: I18nService) {}
    catch(exception: unknown, host: ArgumentsHost) {
      const client = host.switchToWs().getClient<Socket>();
      const traceId = client.data?.traceId;
      // 与 HTTP ErrorsFilter 同 envelope shape
      const envelope = this.format(exception, traceId, client);
      client.emit("error", envelope);
      // 鉴权失败 / 严重错误 → 主动 disconnect
      if (
        exception instanceof AppError &&
        exception.errorCode.httpStatus === 401
      ) {
        client.disconnect(true);
      }
    }
    private format(exception: unknown, traceId: string | undefined, client: Socket) {
      // 复用 HTTP ErrorsFilter 的格式逻辑（提取公共 helper）
      // ...
    }
  }
  ```

- [ ] **Step 3: 提取共用 envelope formatter**

  `libs/common/src/errors/format-envelope.ts`：把 HTTP `ErrorsFilter` 的 envelope formatting 拆成纯函数，HTTP / WS 两边复用。

- [ ] **Step 4: 加 peer dep + 安装**

  ```bash
  pnpm --filter @meshbot/common add -D @nestjs/websockets @nestjs/platform-socket.io socket.io
  ```

  改 package.json peer：

  ```json
  "@nestjs/websockets": "^11",
  "@nestjs/platform-socket.io": "^11",
  "socket.io": "^4"
  ```

**Acceptance**：build clean，单测可放 D3 一起写。

---

### Task D2: TraceId for socket

**Files**:
- Create: `libs/common/src/ws/ws-trace.middleware.ts`
- Modify: `libs/common/src/ws/index.ts`

- [ ] **Step 1: Socket.io middleware**

  ```ts
  import { randomUUID } from "node:crypto";
  import type { Socket } from "socket.io";

  export function wsTraceMiddleware(socket: Socket, next: (err?: Error) => void) {
    const incoming =
      (socket.handshake.headers["x-trace-id"] as string | undefined) ??
      (socket.handshake.auth?.traceId as string | undefined);
    const traceId = typeof incoming === "string" && incoming.length > 0
      ? incoming : randomUUID();
    socket.data.traceId = traceId;
    next();
  }
  ```

- [ ] **Step 2: JWT verify middleware**

  ```ts
  // ws-jwt.middleware.ts
  export function createWsJwtMiddleware(jwtVerify: (token: string) => unknown) {
    return (socket: Socket, next: (err?: Error) => void) => {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.query?.token as string | undefined);
      if (!token) return next(); // 不挡，让 WsAuthGuard 在订阅时拒
      try {
        const payload = jwtVerify(token);
        socket.data.user = payload;
        next();
      } catch (e) {
        next();  // token 不合法也不挡 connect，让 guard 决定
      }
    };
  }
  ```

  注：handshake middleware 即使失败也 `next()`，避免 connection refused 时客户端看不到错误。订阅消息时由 `WsAuthGuard` 报错给前端。

- [ ] **Step 3: BaseGateway helper**（可选）

  ```ts
  export abstract class BaseWebSocketGateway implements OnGatewayConnection {
    @WebSocketServer() server!: Server;
    abstract jwtVerify(token: string): unknown;
    afterInit(server: Server) {
      server.use(wsTraceMiddleware);
      server.use(createWsJwtMiddleware(this.jwtVerify.bind(this)));
    }
    handleConnection(_client: Socket) {
      // 默认实现：允许连接但未鉴权；订阅消息时由 WsAuthGuard 拦
    }
  }
  ```

  注：BaseWebSocketGateway 可选用，业务方可自己实现 afterInit。

**Acceptance**：build clean。

---

### Task D3: health gateway + e2e

**Files**:
- Create: `apps/server-main/src/ws/health.gateway.ts`
- Modify: `apps/server-main/src/app.module.ts`（注册 HealthGateway provider）
- Create: `apps/server-main/test/e2e/ws-health.spec.ts`
- Modify: `apps/server-main/package.json`（dev dep socket.io-client）

- [ ] **Step 1: HealthGateway 示例**

  ```ts
  @WebSocketGateway({ namespace: "ws/health", cors: true })
  export class HealthGateway extends BaseWebSocketGateway {
    constructor(private readonly jwt: JwtService) { super(); }
    jwtVerify(token: string) {
      return this.jwt.verify(token);
    }

    @UseGuards(WsAuthGuard)
    @UseFilters(WsExceptionFilter)
    @SubscribeMessage("ping")
    handlePing(@ConnectedSocket() client: Socket) {
      return { pong: true, traceId: client.data.traceId };
    }
  }
  ```

- [ ] **Step 2: 加 socket.io-client 测试依赖**

  ```bash
  pnpm --filter @meshbot/server-main add -D socket.io-client
  ```

- [ ] **Step 3: e2e**

  3 个 case：
  1. 合法 JWT 连接 → 收到 `pong: true` + traceId
  2. 不带 token 订阅 ping → 收到 error envelope `code: 2 UNAUTHORIZED`
  3. 上游 `x-trace-id` → pong response traceId 等于上游值

**Acceptance**：3 个 e2e case 全绿。

---

## Phase 6 完工验收

```bash
pnpm typecheck
pnpm check:strict
pnpm sync:skills -- --check
pnpm sync:locales -- --check
pnpm test

# 启动期 fail-fast 验证
unset JWT_SECRET DATABASE_URL
pnpm dev:server-main
# 期望：exit 1 + 报错列出 DATABASE_URL / JWT_SECRET 字段

# Snowflake auto NODE_ID
node -e "console.log(require('./libs/common/dist').generateSnowflakeId())"
# 多次跑 → 不同 hostname 派生不同 nodeId

# WebSocket 手测
pnpm dev:server-main &
node -e "
const { io } = require('socket.io-client');
const socket = io('http://localhost:3200/ws/health', {
  auth: { token: '<some valid JWT>' },
});
socket.emit('ping', null, (res) => console.log(res));
"
```

更新 `.claude/CLAUDE.md` + `docs/PHASE_HISTORY.md` 标 Phase 6 ✅。

---

## 风险监控（执行期）

| 风险 | 缓解 |
|---|---|
| Throttler storage 包版本不兼容 | 锁版本 + 不行回 memory + 文档备注 |
| Watchdog 异常路径漏 clearInterval | release 走 try/finally；测试 throw 路径 |
| ConfigModule.forRoot 中 `load` 与 `validate` 顺序 | NestJS 文档：`load` factory 注入的 key 不参与 `validate`；只校验 process.env |
| e2e 用 `ignoreEnvFile: true` + 显式 load 时 validate 抛 | 测试代码已经走 `ignoreEnvFile: true` + `load: [() => ({...})]`，无 env validate 触发 |
| WS handshake middleware 顺序 | trace 先于 jwt；jwt 失败不阻断 connect，由 guard 拦 |

---

## 下一步

按 §依赖图 顺序执行：A1 → C1 → C2 → C3 → B1 → B2 → B3 → D1 → D2 → D3。
每 track 完成单独 commit。
