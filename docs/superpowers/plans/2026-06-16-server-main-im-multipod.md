# server-main IM 多 pod 化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 server-main 的 IM WebSocket 可多 pod 部署 —— 引入 Socket.IO Redis adapter（跨 pod fan-out）+ 强制 websocket-only 传输；有 Redis 才启用，无 Redis 回退单 pod 内存 adapter。

**Architecture:** 新增自定义 `RedisIoAdapter`（继承 NestJS `IoAdapter`）：`createIOServer` 始终设 `transports:['websocket']`，并在 `config.redis` 存在时给 socket.io server 挂 `@socket.io/redis-adapter`（pub/sub）。main.ts 用 `app.useWebSocketAdapter` 接线。ImGateway / EventEmitter2 业务逻辑零改动（adapter 使 room 广播 / fetchSockets / 远程 socket 操作自动跨 pod）。server-agent relay 客户端补 websocket-only。

**Tech Stack:** NestJS（`@nestjs/platform-socket.io`）、socket.io v4、`@socket.io/redis-adapter` v8、ioredis v5、Jest。

**依赖参考**：spec `docs/superpowers/specs/2026-06-16-server-main-im-multipod-design.md`。

**关键既有事实（实现时对齐）：**
- `apps/server-main/src/main.ts`：`bootstrap()` 中先 `const config = await loadAppConfig(AppConfigSchema, {...})`，再 `const app = await NestFactory.create(AppModule.forRoot(config))`，随后全局 pipe/interceptor/filter、`app.setGlobalPrefix("api")`、`await app.listen(config.port)`。
- `RedisConfig` 从 `apps/server-main/src/config/app-config.schema.ts` 导出（`export type RedisConfig`，字段 `{host, port, db, password}`，`config.redis` 可选）。
- 现有 `buildRedis(config)`（app.module.ts）用 `new Redis({host,port,db,password,maxRetriesPerRequest:3,lazyConnect:false})` + `redis.on("error", ...)` 仅 log。本计划的 pub/sub 复用同样构造方式。
- main.ts 已有守卫：`config.redis` 存在但无 `MESHBOT_NODE_ID` → 启动 fail-fast（多副本信号）。与本特性"有 Redis=多 pod"一致，无需改。
- web-agent 浏览器 socket（`lib/im-socket.ts` / `lib/socket.ts`）已是 `transports:['websocket']`，本计划不动。

---

## Task 1: 新增 `@socket.io/redis-adapter` 依赖

**Files:**
- Modify: `apps/server-main/package.json`

- [ ] **Step 1: 加依赖并安装**

在 `apps/server-main/package.json` 的 `dependencies` 增加 `"@socket.io/redis-adapter": "^8.3.0"`（与 socket.io v4 / ioredis v5 兼容；若 8.3.0 不存在取最新 8.x）。然后在仓库根运行：

Run: `pnpm install`
Expected: 安装成功，`@socket.io/redis-adapter` 出现在 lockfile。

- [ ] **Step 2: 验证可解析**

Run: `node -e "require.resolve('@socket.io/redis-adapter')" && echo OK`（在 `apps/server-main` 目录或确认根可解析）
Expected: 打印 `OK`（或解析路径）。

- [ ] **Step 3: Commit**

```bash
git add apps/server-main/package.json pnpm-lock.yaml
git commit -m "build(server-main): 新增 @socket.io/redis-adapter 依赖

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `RedisIoAdapter`（核心，TDD）

**Files:**
- Create: `apps/server-main/src/ws/redis-io.adapter.ts`
- Test: `apps/server-main/src/ws/redis-io.adapter.spec.ts`

> `RedisIoAdapter` 继承 `@nestjs/platform-socket.io` 的 `IoAdapter`。无 Redis 时纯单 pod（默认内存 adapter）+ websocket-only。有 Redis 时额外挂 redis adapter。该 adapter 在 NestFactory 之后手动 `new`（不在 DI 容器），故直接用 `RedisConfig` 构造连接。

- [ ] **Step 1: 写失败测试（无 Redis 路径，确定性、无外部依赖）**

创建 `apps/server-main/src/ws/redis-io.adapter.spec.ts`：

```ts
import { RedisIoAdapter } from "./redis-io.adapter";

describe("RedisIoAdapter", () => {
  it("无 Redis 配置：isClustered=false，createIOServer 强制 websocket-only 且不挂 redis adapter", async () => {
    const adapter = new RedisIoAdapter(undefined as never);
    await adapter.connectToRedis(undefined);
    expect(adapter.isClustered()).toBe(false);

    const server = adapter.createIOServer(0) as {
      opts: { transports?: string[] };
      close: () => void;
    };
    expect(server.opts.transports).toEqual(["websocket"]);
    server.close();
  });

  it("connectToRedis(undefined) 幂等：不抛错、可重复调用", async () => {
    const adapter = new RedisIoAdapter(undefined as never);
    await adapter.connectToRedis(undefined);
    await adapter.connectToRedis(undefined);
    expect(adapter.isClustered()).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest apps/server-main/src/ws/redis-io.adapter.spec.ts`
Expected: FAIL（模块不存在 / RedisIoAdapter 未定义）

- [ ] **Step 3: 实现 RedisIoAdapter**

创建 `apps/server-main/src/ws/redis-io.adapter.ts`：

```ts
import { Logger, type INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import type { ServerOptions, Server } from "socket.io";
import type { RedisConfig } from "../config/app-config.schema";

/**
 * 多 pod IM 适配器。
 * - 始终强制 websocket-only（免 ingress 会话粘性）。
 * - 配了 Redis → 给 socket.io server 挂 @socket.io/redis-adapter（pub/sub），
 *   使 room 广播 / fetchSockets / 远程 socket 操作跨 pod 生效；否则用默认内存
 *   adapter（单 pod，本地 dev 无需 Redis）。
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /** 配了 Redis 则建 pub/sub 连接并构建 redis adapter；无则单 pod，幂等。 */
  async connectToRedis(redisConfig: RedisConfig | undefined): Promise<void> {
    if (!redisConfig) {
      return;
    }
    if (this.adapterConstructor) {
      return;
    }
    const make = (): Redis => {
      const client = new Redis({
        host: redisConfig.host,
        port: redisConfig.port,
        db: redisConfig.db,
        password: redisConfig.password,
        maxRetriesPerRequest: 3,
        lazyConnect: false,
      });
      // 运行期断连 emit 'error'；无监听器会让 Node 抛未捕获异常崩进程。
      // 仅 log，依赖 ioredis 自动重连（与 app.module buildRedis 一致）。
      client.on("error", (err: Error) => {
        this.logger.error(`IM Redis adapter 连接错误（将自动重连）：${err.message}`);
      });
      return client;
    };
    this.pub = make();
    this.sub = this.pub.duplicate();
    this.adapterConstructor = createAdapter(this.pub, this.sub);
  }

  /** 是否多 pod（已挂 redis adapter）。 */
  isClustered(): boolean {
    return this.adapterConstructor !== null;
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      transports: ["websocket"],
    }) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  /** 关闭 pub/sub 连接（进程退出时调用）。 */
  async close(): Promise<void> {
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()]);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest apps/server-main/src/ws/redis-io.adapter.spec.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: typecheck + biome**

Run: `pnpm --filter @meshbot/server-main typecheck && pnpm exec biome check apps/server-main/src/ws/redis-io.adapter.ts apps/server-main/src/ws/redis-io.adapter.spec.ts`
Expected: typecheck PASS；biome clean

- [ ] **Step 6: Commit**

```bash
git add apps/server-main/src/ws/redis-io.adapter.ts apps/server-main/src/ws/redis-io.adapter.spec.ts
git commit -m "feat(server-main): RedisIoAdapter（websocket-only + 可选 Redis adapter）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: main.ts 接线 + 启动日志 + 关闭钩子

**Files:**
- Modify: `apps/server-main/src/main.ts`

- [ ] **Step 1: 接入 RedisIoAdapter**

在 `apps/server-main/src/main.ts` 的 `bootstrap()` 内，在 `const app = await NestFactory.create(...)` 之后、`app.setGlobalPrefix("api")` 之前，加入：

```ts
  const { RedisIoAdapter } = await import("./ws/redis-io.adapter");
  const { Logger } = await import("@nestjs/common");
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis(config.redis);
  app.useWebSocketAdapter(ioAdapter);
  new Logger("IM").log(
    ioAdapter.isClustered()
      ? "IM WebSocket: 多 pod 模式（Redis adapter）"
      : "IM WebSocket: 单 pod 模式（内存 adapter，未配置 Redis）",
  );
```
（也可在文件顶部静态 `import`；用静态 import 时把 `RedisIoAdapter` 与 `Logger` 加到现有 import 区，删去上面的动态 import 两行——二选一，跟文件现有风格一致即可。）

并在进程退出时关闭 pub/sub：在 `await app.listen(...)` 之后追加：

```ts
  const closeIo = () => {
    void ioAdapter.close();
  };
  process.once("SIGTERM", closeIo);
  process.once("SIGINT", closeIo);
```

- [ ] **Step 2: typecheck + biome**

Run: `pnpm --filter @meshbot/server-main typecheck && pnpm exec biome check apps/server-main/src/main.ts`
Expected: typecheck PASS；biome clean

- [ ] **Step 3: 冒烟（无 Redis 启动 → 单 pod 日志）**

在不配置 Redis 的环境启动 server-main（或确认现有 dev 配置无 `config.redis` 时），日志应出现 `IM WebSocket: 单 pod 模式`。若本地无法快速起服务，跳过此步，由 Task 6 的集成/手验覆盖。

- [ ] **Step 4: Commit**

```bash
git add apps/server-main/src/main.ts
git commit -m "feat(server-main): main.ts 接入 RedisIoAdapter + 模式日志 + 关闭钩子

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: server-agent relay 客户端 websocket-only

**Files:**
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts`

- [ ] **Step 1: relay 连接加 transports**

READ `apps/server-agent/src/cloud/im-relay-client.service.ts`，找到 `this.ioFactory(url, { auth: {...}, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10_000 })`，在该 options 对象加入 `transports: ["websocket"]`：

```ts
      const socket = this.ioFactory(url, {
        auth: { token: identity.cloudToken },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10_000,
      });
```

> 服务端 RedisIoAdapter 将强制 ws-only，relay 必须匹配，否则握手失败。

- [ ] **Step 2: typecheck + biome + 现有 relay 单测**

Run: `pnpm --filter @meshbot/server-agent typecheck && pnpm exec biome check apps/server-agent/src/cloud/im-relay-client.service.ts`
Expected: typecheck PASS；biome clean
Run: `npx jest apps/server-agent/src/cloud/im-relay-client.service.spec.ts`
Expected: 现有 relay 单测仍 PASS（若测试断言了 ioFactory 入参，更新断言以含 `transports:["websocket"]`）

- [ ] **Step 3: Commit**

```bash
git add apps/server-agent/src/cloud/im-relay-client.service.ts apps/server-agent/src/cloud/im-relay-client.service.spec.ts
git commit -m "feat(server-agent): IM relay 客户端 websocket-only（对齐服务端多 pod 适配）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 跨实例 fan-out 集成测试（Redis-gated，可选但建议）

**Files:**
- Create: `apps/server-main/test/e2e/im-multipod.spec.ts`

> 验证两个独立 socket.io Server 共享同一 Redis adapter 时，A 实例房间内 `emit` 能被连在 B 实例的客户端收到。需本地 Redis（`pnpm dev:db:up` 起的 redis 在 6380；或 `REDIS_HOST`/`REDIS_PORT`）。Redis 不可达则整 suite skip（沿用现有 e2e harness 的 reachable-skip 风格）。本测试只验 adapter 的跨实例广播，不拉起完整 Nest app。

- [ ] **Step 1: 写集成测试**

创建 `apps/server-main/test/e2e/im-multipod.spec.ts`：

```ts
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Server } from "socket.io";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";

const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6380);

async function redisReachable(): Promise<boolean> {
  const probe = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await probe.connect();
    await probe.quit();
    return true;
  } catch {
    probe.disconnect();
    return false;
  }
}

/** 起一个挂了 redis adapter 的 socket.io Server（websocket-only），返回 server + port + 清理函数。 */
async function startNode(): Promise<{ io: Server; http: HttpServer; port: number; pub: Redis; sub: Redis; close: () => Promise<void> }> {
  const pub = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  const sub = pub.duplicate();
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  io.adapter(createAdapter(pub, sub));
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  return {
    io, http, port, pub, sub,
    close: async () => {
      io.close();
      await new Promise<void>((r) => http.close(() => r()));
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}

describe("IM 多 pod fan-out（Redis adapter）", () => {
  let skip = false;
  beforeAll(async () => {
    if (!(await redisReachable())) {
      skip = true;
      console.warn(`[im-multipod] Redis(${REDIS_HOST}:${REDIS_PORT}) 不可达，skip`);
    }
  });

  it("A 实例房间 emit → 连在 B 实例的客户端收到", async () => {
    if (skip) return;
    const a = await startNode();
    const b = await startNode();
    // B 实例：客户端连上后加入房间 "room1"
    b.io.on("connection", (s) => s.join("room1"));

    const client = createClient(`http://localhost:${b.port}`, { transports: ["websocket"], reconnection: false });
    await new Promise<void>((res, rej) => {
      client.on("connect", () => res());
      client.on("connect_error", rej);
    });
    // 等 B 端 join 完成
    await new Promise((r) => setTimeout(r, 200));

    const got = new Promise<string>((res) => client.on("ping-room", (msg: string) => res(msg)));
    // 从 A 实例向 room1 广播 —— 跨实例经 redis adapter 到达 B 实例的客户端
    a.io.to("room1").emit("ping-room", "hello-cross-node");

    await expect(got).resolves.toBe("hello-cross-node");

    client.close();
    await a.close();
    await b.close();
  }, 15_000);
});
```

- [ ] **Step 2: 起本地 Redis 并运行**

Run: `pnpm dev:db:up`（启动 dev redis，宿主映射 6380），稍候就绪
Run: `REDIS_PORT=6380 npx jest apps/server-main/test/e2e/im-multipod.spec.ts`
Expected: PASS（Redis 可达时）；若 Redis 不可达 → suite SKIP（用例内 early-return），报告哪种情况

- [ ] **Step 3: typecheck + biome**

Run: `pnpm --filter @meshbot/server-main typecheck && pnpm exec biome check apps/server-main/test/e2e/im-multipod.spec.ts`
Expected: typecheck PASS；biome clean

- [ ] **Step 4: Commit**

```bash
git add apps/server-main/test/e2e/im-multipod.spec.ts
git commit -m "test(server-main): IM 多 pod 跨实例 fan-out 集成测试（Redis-gated）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 全量验证 + 收尾

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm typecheck`
Expected: 全包 PASS

- [ ] **Step 2: 静态围栏全套**

Run: `pnpm check`
Expected: 6 围栏全 0 新增 finding

- [ ] **Step 3: 相关测试**

Run: `npx jest apps/server-main/src/ws/redis-io.adapter.spec.ts`（必跑）；`REDIS_PORT=6380 npx jest im-multipod`（有 Redis 时）
Expected: redis-io.adapter 单测 PASS；多 pod 集成测试 PASS 或 SKIP（无 Redis）

- [ ] **Step 4: 手验（部署侧，可后置）**

配 `config.redis` + `MESHBOT_NODE_ID` 起 ≥2 个 server-main 实例（或 k8s 2+ pod），两浏览器分别落不同实例，互发消息 / 拉人 / presence 实时可达；启动日志为"多 pod 模式"。不配 Redis 单实例：日志"单 pod 模式"，行为与现状一致。

- [ ] **Step 5: 最终 Commit（如有零碎）**

```bash
git add -A && git commit -m "chore(server-main): IM 多 pod 化收尾（typecheck/围栏/测试）" || echo "无额外改动"
```

---

## 自检记录（spec 覆盖）

- Socket.IO Redis adapter（pub/sub）经 IoAdapter 接入 → Task 2 + Task 3 ✓
- websocket-only（服务端强制）→ Task 2（createIOServer）✓；客户端 relay → Task 4 ✓；浏览器已 ws-only（不改）✓
- 门控：有 Redis 才启 adapter，无则单 pod → Task 2（connectToRedis 判空）+ Task 3（日志）✓
- 网关/EventEmitter2 零改动 → 计划未触碰 ImGateway/ImController（spec §4）✓
- presence 自洽 → 由门控保证（无新代码）✓
- 错误处理（pub/sub error 仅 log + ioredis 重连）→ Task 2 ✓
- 关闭 pub/sub → Task 2 close() + Task 3 信号钩子 ✓
- 依赖 @socket.io/redis-adapter → Task 1 ✓
- 测试（adapter 单测 + 跨实例集成）→ Task 2 + Task 5 ✓
- 全量类型/围栏 → Task 6 ✓
