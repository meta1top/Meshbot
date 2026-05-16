# meshbot Phase 6：多实例正确性 + 启动期约束 + WebSocket 框架预备

- 日期：2026-05-17
- 范围：Phase 1-5 之上补「多实例 server-main 正确性」+「启动期 fail-fast」+「实时通信 gateway 骨架」
- 形态：一份 spec，4 个 track，~10 task
- 不含：监控（用户明确推迟）/ 业务模型 / k8s / 多环境完整链路 / WebSocket 业务消息路由

---

## 1. 总体目标与范围

### 1.1 目标

把 server-main 从「单实例可跑」推到「多实例可水平扩容」+ 启动期错误前置发现 + 为未来多 agent 协同 gateway 准备 WebSocket 骨架。

### 1.2 四条 track

| Track | 主题 | task |
|---|---|---|
| **A** | Throttler Redis storage（多实例限流准确） | 1 |
| **B** | RedisLock TTL watchdog 续期 | 3 |
| **C** | Snowflake 自动 NODE_ID + Zod env 启动期校验 | 3 |
| **D** | WebSocket Gateway 框架基建 | 3 |

合计 **10 task**。

### 1.3 不在范围

- ❌ **监控**（Sentry / OTel / Grafana）—— 用户明确推迟
- ❌ **业务模型**（云端协同业务领域设计）—— meshbot 自行迭代
- ❌ **k8s / Helm Chart** —— Phase 4 单机 docker-compose 已够；集群推迟
- ❌ **多环境完整链路**（dev / staging / prod 完整 CI/CD）—— 业务定后再设计
- ❌ **socket.io Redis adapter**（多实例 pub/sub）—— Track D 仅骨架 + 单实例；Redis adapter 等业务 WebSocket 真用上再加
- ❌ **WebSocket 业务消息路由 / Agent 间协议设计** —— meshbot 自行
- ❌ **Idempotency-Key 中间件** —— 业务出现重试场景再加

### 1.4 退出标志

- server-main 部署 ≥ 2 个副本时，限流计数在所有副本间共享准确（同 IP 总命中数 = 副本数 × 单副本数 是错的，应等于单副本独占数）
- `@WithLock` 长时方法（> ttlMs）不丢锁，可通过 watchdog 自动续期
- server-main / server-agent 启动时缺 `JWT_SECRET` / 不合法 `DATABASE_URL` → exit 1 + 报错明确指向哪条 env
- 多副本 server-main 无需手工配 `MESHBOT_NODE_ID`：自动从 hostname hash 取低 10bit
- WebSocket `/api/ws/health` 示例端点：握手时验 JWT，成功后 emit `traceId`；连接错误统一 envelope shape
- `pnpm typecheck` / `pnpm test` / `pnpm check:strict` / `pnpm sync:*` 全绿
- CLAUDE.md / PHASE_HISTORY.md 标 Phase 6 ✅

---

## 2. Track A — Throttler Redis storage

### 2.1 任务

| # | 资产 | 行动 |
|---|---|---|
| **A1** | server-main `ThrottlerModule.forRootAsync` | 按 `REDIS_URL` 选 `ThrottlerStorageRedisService`（共享 Redis 客户端实例）或默认 memory；server-agent 保持 memory（单进程足够）|

### 2.2 实现要点

- 加依赖：`@nest-lab/throttler-storage-redis`（社区维护，与 NestJS 11 / Throttler 6 兼容）
- 复用 `apps/server-main/src/app.module.ts` 里已有的 `Redis` 实例（避免开第二个连接池）
- `ThrottlerModule.forRootAsync({ inject: [ConfigService], useFactory: (cfg) => ({ throttlers: [...], storage: cfg.get('REDIS_URL') ? new ThrottlerStorageRedisService(redis) : undefined }) })`
- 不影响 server-agent（明确单实例，memory 即可）

---

## 3. Track B — RedisLock TTL watchdog 续期

### 3.1 任务

| # | 资产 | 行动 |
|---|---|---|
| **B1** | `WithLockOptions` 加 `watchdog?: boolean`（默认 false）与 `renewIntervalMs?` | `@WithLock({ key, ttl: 30000, watchdog: true })` |
| **B2** | `RedisLockProvider.acquire` 接受 watchdog 回调 / `MemoryLockProvider` 兼容（no-op） | acquire 后启 `setInterval`：每 `ttl/3` 用 Lua 脚本验 token + PEXPIRE 续期；release 时清定时器 |
| **B3** | 单测覆盖：长任务不丢锁 / release 后 watchdog 停 / 续期失败（key 不存在或 token 不匹配）静默退出 | `RedisLockProvider.spec.ts` 加 3 用例 |

### 3.2 设计要点

**问题**：Phase 4 RedisLock 用 `SET PX NX`，业务方法跑超 `ttl` 锁自动释放 → 后续请求竞争 → 同时执行 = 失幂等。

**方案**：可选 watchdog，acquire 时启定时器每 `ttl/3` 续期，verify token 匹配防误续他人锁：

```lua
-- renewIfMine.lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
```

**Memory 模式 no-op**：MemoryLockProvider 用 async-mutex，无 TTL 概念，watchdog 自动跳过（接口签名一致）。

**关键约束**：续期失败（返回 0）说明锁已被他人占据，watchdog 立即清掉自己的定时器并打 warn 日志，**不**抛错（任务可能正在跑，抛错破坏业务）。

---

## 4. Track C — Snowflake auto NODE_ID + Zod env 启动期校验

### 4.1 任务

| # | 资产 | 行动 |
|---|---|---|
| **C1** | `libs/common/src/utils/snowflake.ts` 加 `deriveNodeIdFromHostname()` | 优先 `MESHBOT_NODE_ID` env；其次 hostname FNV-1a hash 取低 10bit；最后 fallback 0 + 一行 warn 日志 |
| **C2** | `libs/common/src/config/env-schema.ts` —— 公共 Zod env schema 助手 + `validateEnv` factory | 提供 `createEnvValidator(schema)` 给 `ConfigModule.forRoot({ validate })` 用；失败抛带定位的 `AppError(INTERNAL_ERROR)` |
| **C3** | server-main + server-agent 各自 `env.schema.ts` + 接入 `ConfigModule.validate` | 校验 `DATABASE_URL` / `JWT_SECRET` / `REDIS_URL`（可选）/ `JWT_EXPIRES` / `PORT` 等 |

### 4.2 实现要点

**Snowflake auto NODE_ID**：

```ts
import { hostname } from "node:os";

function fnv1aHash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function deriveNodeId(): number {
  const explicit = process.env.MESHBOT_NODE_ID;
  if (explicit !== undefined) return Number(explicit);
  const h = fnv1aHash(hostname());
  return h & 0x3ff; // 取低 10bit
}
```

**Env Zod schema 接入**：

```ts
// apps/server-main/src/env.schema.ts
import { z } from "zod";
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET 至少 16 字符"),
  JWT_EXPIRES: z.string().regex(/^\d+[smhd]$/).default("7d"),
  REDIS_URL: z.string().url().startsWith("redis").optional(),
});
```

`ConfigModule.forRoot({ isGlobal: true, validate: createEnvValidator(EnvSchema), envFilePath: [...] })`。

校验失败 NestJS 直接 exit 1 + 抛带字段路径的清晰错误（不需 wrap AppError —— config 阶段没有 i18n / response envelope 链路）。

---

## 5. Track D — WebSocket Gateway 框架基建

### 5.1 任务

| # | 资产 | 行动 |
|---|---|---|
| **D1** | `libs/common/src/ws/` —— `WsAuthGuard` + `WsExceptionFilter` + `BaseGateway` 抽象 | JWT 从 `socket.handshake.auth.token` 或 `?token=` 取；exception 走 envelope `{success:false, code, message, data, traceId}` 通过 `socket.emit("error", envelope)` 发给客户端 |
| **D2** | TraceId for socket | connection 时注入 `socket.data.traceId`（透传 handshake `x-trace-id` 或新生成 UUID） |
| **D3** | 示例 health gateway + e2e | `apps/server-main/src/ws/health.gateway.ts`：`@WebSocketGateway({ namespace: "health" })` + `@SubscribeMessage("ping")` 返 `{ pong: true, traceId }`；e2e 验证 auth + traceId |

### 5.2 设计要点

**Socket.io 选型**：NestJS 默认（`@nestjs/websockets` + `@nestjs/platform-socket.io`）。`ws` 太底层、`@nestjs/platform-ws` 缺生态。

**单实例 only**：Phase 6 用 socket.io 默认 memory adapter。多实例 / 跨副本广播 → 未来 Track（加 `@socket.io/redis-adapter`）；当前业务无消息广播需求，骨架先建。

**Handshake 校验顺序**：
1. `WsAuthGuard.canActivate` 拿到 `client: Socket`
2. 取 `client.handshake.auth?.token`（标准做法）或 `?token=`（备用）
3. `jwtService.verify(token)` → 写入 `client.data.user = { userId, email }`
4. 失败：抛 `WsException(AppError(UNAUTHORIZED))` → `WsExceptionFilter` 转 envelope emit 给 client 后 `disconnect(true)`

**TraceId 注入**：
- 连接时 middleware：`handshake.headers["x-trace-id"]` 透传或 randomUUID
- 写入 `client.data.traceId`
- 后续 SubscribeMessage handler 通过 `@ConnectedSocket() client` 取

**为什么不做业务消息路由**：业务消息（join room / send message / agent event 等）是 meshbot 自行设计的领域，骨架不做约束。

### 5.3 e2e 测试

用 `socket.io-client` + supertest http server 验证：
- 带合法 JWT → 连接成功 + `ping` 收到 pong + traceId 写回
- 不带 token → 连接被拒（emit error envelope + disconnect）
- 上游 `x-trace-id` header → 透传到 pong response 的 traceId 字段

---

## 6. 风险 / 未决 / Phase 7 衔接

### 6.1 已知风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `@nest-lab/throttler-storage-redis` 与 NestJS 11 / Throttler 6 版本不齐 | 升级 / 锁版本；若不兼容回退 memory + 文档提醒「多实例限流当前不准」 |
| R2 | Watchdog 定时器漏停（异常路径） | `acquire` 返回的 release 必须 `try/finally` 兜底；测试覆盖 throw / reject 路径 |
| R3 | Hostname hash 冲突（10bit 1024 桶） | 文档化「副本数 ≤ 100 时 birthday paradox 冲突概率 ~1%」；要求关键场景仍配 env |
| R4 | env 校验在 dev `.env` 缺失时阻断本地起 server | `.env.development.example` 已包含全部 key；校验报错引导开发者复制此文件 |
| R5 | WebSocket auth guard 与 HTTP JwtAuthGuard 不一致 | 两边都从同一 `JwtService.verify`；共享 payload schema；TraceId 同 middleware |

### 6.2 未决问题

- Q1：WebSocket 是否走 `/api/ws` 路径前缀 → **是**（与 HTTP API `/api/*` 对齐）
- Q2：env schema 是否给 web-* 也加 → Phase 6 不做（Next.js 自己有 env 校验生态），未来再考虑

---

## 7. 下一步

写 plan → 按顺序执行：A → C → B → D（A/C 是小台阶，B/D 是 watchdog 与 WS 框架的较大投入）。
