# meshbot Phase 4 实施 Plan — CI/CD + Redis + Docker + 发布工具链

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Spec**: [2026-05-16-meshbot-phase-4-design.md](../specs/2026-05-16-meshbot-phase-4-design.md)
- **Date**: 2026-05-16
- **Goal**: 让 meshbot 从「本地能跑 + 框架完备」进入「可持续交付」——PR CI / Redis 落地 / Docker 化 / 发布自动化
- **不在范围**: 监控（Sentry / OTel）、业务迭代、k8s / Helm、Redis HA、多环境完整链路。详见 spec §1.3

---

## 任务依赖图

```
A0（preflight）─→ A1（ci.yml 主体）─→ A2（matrix / strict）─→ A3（README badge + 文档）
                                                                            │
                                                                            ↓
E1（isolatedModules 迁移，独立）─────────────────────────────────────────┐
                                                                          │
B1（RedisLockProvider）─┐                                                  │
B2（RedisCacheProvider）├─→ B3（CommonModule.forRootAsync）─→ B4（dev compose redis + 测试）
                                                                          │
C1（server-main Dockerfile）─┐                                            │
C2（server-agent Dockerfile）├─→ C3（docker-compose.prod.yml）─→ C4（.dockerignore + CI smoke）
                                                                          │
D1（changesets 接入）─→ D2（release.yml）─→ D3（重构 publish workflow）─→ D4（文档）
                                                                          │
E2（pre-commit 并行化，最后收尾）
```

**强依赖**：
- `A0` 必须先做（修 server-agent baseline，否则 CI 启用 --strict 直接红）
- `B3` 依赖 B1 + B2
- `C3` 依赖 C1 + C2
- `D2 / D3` 依赖 A1（复用 CI step）
- `C4` 依赖 A1 + C1（CI 加 docker build smoke）
- `B4` 依赖 A1（CI 需要 redis service）

**推荐顺序**：`A0 → A1 → A2 → A3 → E1 → B1 → B2 → B3 → B4 → C1 → C2 → C3 → C4 → D1 → D2 → D3 → D4 → E2`

---

## Track A — CI/CD（GitHub Actions PR 主流水线）

### Task A0: 修 server-agent REDUNDANT @Transactional baseline

**Why**: Phase 3 spec 把 `apps/server-agent/src/services/auth.service.ts:23` 的 `register` 方法挂了 `@Transactional()`，但方法体内只有 1 处 `userRepo.save(...)`，构成 `REDUNDANT` finding。CI 启用 `--strict` 前必须先修，否则 A2 直接被自己卡住。

**Files**:
- Modify: `apps/server-agent/src/services/auth.service.ts`

- [ ] **Step 1**：去掉 `register` 方法上的 `@Transactional()` 装饰器
- [ ] **Step 2**：单测 / e2e 重跑确认未回归
- [ ] **Step 3**：`pnpm check:tx` 0 finding（旧 baseline 也归零）

**Acceptance**:
- `pnpm check:tx` 共发现 0 个问题
- `pnpm test` 全绿

---

### Task A1: 主流水线 `.github/workflows/ci.yml`

**Files**:
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 触发器 + 并发控制**

  ```yaml
  name: CI
  on:
    pull_request:
      branches: [main]
    push:
      branches: [main]
  concurrency:
    group: ci-${{ github.ref }}
    cancel-in-progress: true
  ```

- [ ] **Step 2: ci job 骨架**

  ```yaml
  jobs:
    ci:
      runs-on: ubuntu-latest
      timeout-minutes: 20
      services:
        postgres:
          image: postgres:16-alpine
          env:
            POSTGRES_USER: meshbot
            POSTGRES_PASSWORD: meshbot
            POSTGRES_DB: meshbot_main
          ports: ["5432:5432"]
          options: >-
            --health-cmd "pg_isready -U meshbot -d meshbot_main"
            --health-interval 5s
            --health-timeout 3s
            --health-retries 10
      env:
        DATABASE_URL: postgresql://meshbot:meshbot@localhost:5432/meshbot_main
        # JWT_SECRET 在测试代码里 mock，无需 secret
      steps:
        - uses: actions/checkout@v6
        - uses: pnpm/action-setup@v6
        - uses: actions/setup-node@v6
          with:
            node-version: 22
            cache: pnpm
        - run: pnpm install --frozen-lockfile
        - run: pnpm lint
        - run: pnpm typecheck
        - run: pnpm check
        - run: pnpm sync:skills -- --check
        - run: pnpm sync:locales -- --check
        - run: pnpm test
        - run: pnpm build
  ```

  注：`pnpm check` 当前未支持 `--strict`，A2 加。Phase 4a 阶段先靠 `pnpm check` + baseline 模式（与 pre-commit 等价）。

- [ ] **Step 3: 本地复刻**

  通过 [act](https://github.com/nektos/act)（可选）或直接照命令清单跑 `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm check && pnpm test && pnpm build`，验证步骤都能通。

- [ ] **Step 4: 推 PR 触发**

  push branch + 开 PR，确认 workflow 自动跑且全绿。

**Acceptance**:
- PR 触发 workflow 自动跑
- 主 job 在 < 10 分钟内全绿（首次冷缓存可能稍长）
- e2e 用 Postgres service 成功跑过 7 case

---

### Task A2: 启用 `--strict` 围栏 + Node engines 锁版本

**Files**:
- Modify: `package.json`（根，新增 `check:strict` script + `engines.node`）
- Modify: `scripts/check-*.ts`（5 个 fence，确认 `--strict` 标志已支持；不支持的补上）
- Modify: `.github/workflows/ci.yml`（A1 主体改 `pnpm check:strict`）

- [ ] **Step 1: 确认 fence 脚本支持 `--strict`**

  ```bash
  grep -l "strict" scripts/check-*.ts
  ```

  从 Phase 1 / 2 实现看，5 个 fence 都接受 `--strict`（违例任意 ≥ 1 即 exit 1，不靠 baseline 增量）。如缺则补。

- [ ] **Step 2: 根 package.json 加 strict 别名**

  ```json
  "check:strict": "pnpm check:tx -- --strict && pnpm check:naming -- --strict && pnpm check:lock-tx -- --strict && pnpm check:repo -- --strict && pnpm check:dead -- --strict"
  ```

- [ ] **Step 3: 锁 Node 版本**

  根 `package.json`：

  ```json
  "engines": { "node": ">=22 <23", "pnpm": ">=10" }
  ```

  CI 的 `setup-node` 已是 22；与 engines 对齐。

- [ ] **Step 4: CI 切 `pnpm check:strict`**

  `.github/workflows/ci.yml` 改 `- run: pnpm check:strict`。

- [ ] **Step 5: 验证**

  - `pnpm check:strict` 本地跑 → 0 finding（A0 已修 server-agent baseline）
  - PR 触发 → 绿
  - 故意引入一个 REDUNDANT @Transactional 看 CI 应阻断

**Acceptance**:
- `pnpm check:strict` 本地 exit 0
- CI 启用 strict 后绿

---

### Task A3: README badge + CONTRIBUTING 本地复刻指引

**Files**:
- Modify: `README.md`
- Create or Modify: `CONTRIBUTING.md`

- [ ] **Step 1: README CI badge**

  在 README 顶部加：

  ```markdown
  [![CI](https://github.com/<org>/meshbot/actions/workflows/ci.yml/badge.svg)](https://github.com/<org>/meshbot/actions/workflows/ci.yml)
  ```

- [ ] **Step 2: 本地复刻 CI 命令清单**

  README 加 section「本地跑全部 CI 步骤」：

  ```bash
  pnpm install --frozen-lockfile
  pnpm dev:db:up
  pnpm lint
  pnpm typecheck
  pnpm check:strict
  pnpm sync:skills -- --check
  pnpm sync:locales -- --check
  pnpm test
  pnpm build
  ```

- [ ] **Step 3: CONTRIBUTING.md**

  新建（或更新）文档：

  - 「提交 PR 前的本地检查」（上述命令）
  - 「pre-commit 在做什么」
  - 「如何提交一个 changeset」（占位，D 落地后回填）

**Acceptance**:
- README 顶部显示 CI badge
- CONTRIBUTING.md 含本地复刻命令 + pre-commit 说明

---

## Track E1 — `ts-jest isolatedModules` 警告消除

> Track E 拆成两部分；E1 顺手做，E2 留到最后。

### Task E1: 把 `isolatedModules` 从 ts-jest transformer 迁移到 tsconfig

**Why**: 每跑一次 jest 都打 `ts-jest[config] (WARN) The "ts-jest" config option "isolatedModules" is deprecated` —— ts-jest v30 起从 tsconfig 读，不再认 transformer options。

**Files**:
- Modify: `jest.config.ts`
- Modify: `tsconfig.base.json`

- [ ] **Step 1: tsconfig.base.json 加字段**

  ```json
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "isolatedModules": true,   // ← 新增
    "...其它...": true
  }
  ```

- [ ] **Step 2: jest.config.ts 去掉**

  ```ts
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.base.json",
        // isolatedModules: true,   // ← 删除
      },
    ],
  },
  ```

- [ ] **Step 3: 验证**

  ```bash
  pnpm test 2>&1 | grep "isolatedModules"
  ```

  应无输出（警告消失）。

**Acceptance**:
- `pnpm test` 输出不再包含 `isolatedModules deprecated` 警告
- 30 个测试仍全绿
- `pnpm typecheck` 仍全绿（`isolatedModules` 可能催出新错误；如有则修）

---

## Track B — Redis Provider

### Task B1: `RedisLockProvider`

**Files**:
- Create: `libs/common/src/lock/redis-lock.provider.ts`
- Create: `libs/common/src/lock/redis-lock.provider.spec.ts`
- Modify: `libs/common/package.json`（peer dep `ioredis`）
- Modify: `libs/common/src/lock/index.ts`（导出）

- [ ] **Step 1: 加依赖**

  ```bash
  pnpm --filter @meshbot/common add ioredis
  # 单测可选 mock
  pnpm --filter @meshbot/common add -D ioredis-mock
  ```

  把 `ioredis` 放 dependencies；如果想做成 peer dep 同 nestjs-i18n 模式也可。建议 dependencies（让用户无需手动装）。

- [ ] **Step 2: 实现**

  ```ts
  import { randomUUID } from "node:crypto";
  import type Redis from "ioredis";
  import type { LockProvider, LockRelease } from "./lock.provider";

  const RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  /**
   * 基于单点 Redis 的 LockProvider（Redlock 单点变体）。
   * - SET NX PX 申请锁；token 防止释放他人的锁
   * - 释放走 Lua 原子脚本（get+del 同一事务）
   * - waitMs 内拿不到锁抛 LOCK_ACQUIRE_FAILED
   *
   * 注：Phase 4 不做 TTL 续期（watchdog）。业务方法应保持短；
   * 超 ttlMs 仍未完成的视为异常，锁自动释放 → 后续请求竞争。
   */
  export class RedisLockProvider implements LockProvider {
    constructor(private readonly redis: Redis) {}

    async acquire(key: string, ttlMs: number, waitMs: number): Promise<LockRelease> {
      const token = randomUUID();
      const deadline = Date.now() + waitMs;
      do {
        const ok = await this.redis.set(key, token, "PX", ttlMs, "NX");
        if (ok === "OK") {
          let released = false;
          return async () => {
            if (released) return;
            released = true;
            await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
          };
        }
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      } while (true);
      throw new Error("LOCK_ACQUIRE_FAILED");
    }
  }
  ```

- [ ] **Step 3: 单测**

  覆盖：
  - acquire 成功 → release 删 key
  - acquire 拿到锁后并发申请等待 → 超时抛 LOCK_ACQUIRE_FAILED
  - acquire 拿到锁 → release 后再申请成功
  - TTL 过期后无需 release 也能再申请
  - release 幂等（连续两次不抛错、不删别人的锁）

  用 `ioredis-mock` 或开实际 docker redis 容器（推荐 mock，CI 快）。

- [ ] **Step 4: 导出**

  `libs/common/src/lock/index.ts` 加 `export { RedisLockProvider } from "./redis-lock.provider";`

**Acceptance**:
- 5 个单测 case 全绿
- `pnpm --filter @meshbot/common build` clean
- `pnpm check` 0 finding

---

### Task B2: `RedisCacheProvider`

**Files**:
- Create: `libs/common/src/cache/redis-cache.provider.ts`
- Create: `libs/common/src/cache/redis-cache.provider.spec.ts`
- Modify: `libs/common/src/cache/index.ts`
- Possibly modify: `libs/common/src/cache/cache.provider.ts`（接口对齐）
- Possibly modify: `libs/common/src/cache/memory-cache.provider.ts`（接口补齐）

- [ ] **Step 1: 对齐接口**

  读现有 `CacheProvider` 接口；如果有 `get / set / del`，本任务沿用；缺 `delByPrefix` 就加（Redis 用 SCAN+DEL）。Memory 同步补齐（async-iter LRU keys → 匹配 prefix → 删）。

- [ ] **Step 2: 实现 RedisCacheProvider**

  ```ts
  import type Redis from "ioredis";
  import type { CacheProvider } from "./cache.provider";

  export class RedisCacheProvider implements CacheProvider {
    constructor(private readonly redis: Redis) {}

    async get<T>(key: string): Promise<T | null> {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    }

    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      await this.redis.set(key, JSON.stringify(value), "PX", ttlMs);
    }

    async del(key: string): Promise<void> {
      await this.redis.del(key);
    }

    async delByPrefix(prefix: string): Promise<void> {
      const stream = this.redis.scanStream({ match: `${prefix}*`, count: 100 });
      const pipeline = this.redis.pipeline();
      for await (const keys of stream) {
        for (const k of keys as string[]) pipeline.del(k);
      }
      await pipeline.exec();
    }
  }
  ```

- [ ] **Step 3: 单测**

  - set + get 往返
  - set 带 TTL → 等 TTL 后 get null
  - del 后 get null
  - delByPrefix 命中多 key

- [ ] **Step 4: 导出**

**Acceptance**:
- 单测全绿
- Memory + Redis 两种 provider 接口一致（typecheck 双绑通过）

---

### Task B3: `CommonModule.forRootAsync` + server-main / server-agent 接入

**Files**:
- Modify: `libs/common/src/common.module.ts`（新增 `forRootAsync`）
- Modify: `apps/server-main/src/app.module.ts`（用 forRootAsync 注入 Redis providers）
- Modify: `apps/server-agent/src/app.module.ts`（保留 memory 兜底；可选支持 REDIS_URL）
- Modify: `apps/server-main/.env.development.example`（加 `# REDIS_URL=redis://localhost:6379`）

- [ ] **Step 1: 加 `forRootAsync`**

  ```ts
  static forRootAsync(options: {
    imports?: ModuleMetadata["imports"];
    inject?: any[];
    useFactory: (...args: any[]) => CommonModuleOptions | Promise<CommonModuleOptions>;
  }): DynamicModule {
    return {
      module: CommonModule,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [
        {
          provide: "COMMON_MODULE_OPTIONS",
          inject: options.inject,
          useFactory: options.useFactory,
        },
        LockInitializer,
        CacheInitializer,
        {
          provide: LOCK_PROVIDER,
          inject: ["COMMON_MODULE_OPTIONS"],
          useFactory: (opts: CommonModuleOptions) => {
            const choice = opts.lock ?? "memory";
            return choice === "memory" ? new MemoryLockProvider() : choice;
          },
        },
        {
          provide: CACHE_PROVIDER,
          inject: ["COMMON_MODULE_OPTIONS"],
          useFactory: (opts: CommonModuleOptions) => {
            const choice = opts.cache ?? "memory";
            return choice === "memory" ? new MemoryCacheProvider() : choice;
          },
        },
      ],
      exports: [LOCK_PROVIDER, CACHE_PROVIDER],
      global: true,
    };
  }
  ```

- [ ] **Step 2: server-main 接入**

  ```ts
  CommonModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (cfg: ConfigService) => {
      const redisUrl = cfg.get<string>("REDIS_URL");
      if (!redisUrl) return {};  // memory 兜底
      const redis = new Redis(redisUrl);
      return {
        lock: new RedisLockProvider(redis),
        cache: new RedisCacheProvider(redis),
      };
    },
  }),
  ```

- [ ] **Step 3: 关闭连接的 hook（生命周期）**

  添加 `onApplicationShutdown` 关 Redis（用 Nest `OnModuleDestroy`）。可在 RedisLockProvider 加 `close()` 或外部封装 RedisModule。

- [ ] **Step 4: env example 更新**

- [ ] **Step 5: 冒烟**

  - `unset REDIS_URL && pnpm dev:server-main` —— memory 兜底，正常
  - `REDIS_URL=redis://localhost:6379 pnpm dev:server-main` —— 走 Redis（B4 起 redis 容器后验证）

**Acceptance**:
- `pnpm --filter @meshbot/common build` clean
- 两种 env 配置下 server-main 正常启动
- typecheck 全绿

---

### Task B4: dev infra 加 redis + e2e 双跑

**Files**:
- Modify: `infra/dev/docker-compose.dev.yml`（加 redis 服务）
- Modify: `apps/server-main/test/e2e/auth-flow.spec.ts`（`describe.each([["memory"], ["redis"]])`）
- Modify: `.github/workflows/ci.yml`（CI services 加 redis）

- [ ] **Step 1: docker-compose.dev.yml**

  ```yaml
  redis:
    image: redis:7-alpine
    container_name: meshbot-dev-redis
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
  ```

- [ ] **Step 2: e2e 双 provider 跑**

  把 `auth-flow.spec.ts` 改为 `describe.each([["memory"], ["redis"]])("server-main e2e (%s)", (mode) => { ... })`。redis 模式下传 `lock: new RedisLockProvider(...)` / `cache: new RedisCacheProvider(...)`；memory 模式不传。

  redis 不可达则该 describe block skip（用 `B0Probe` 类似 isPostgresReachable）。

- [ ] **Step 3: CI 加 redis service**

  `.github/workflows/ci.yml`：

  ```yaml
  services:
    postgres: ...
    redis:
      image: redis:7-alpine
      ports: ["6379:6379"]
      options: --health-cmd "redis-cli ping" --health-interval 5s --health-retries 5
  env:
    DATABASE_URL: ...
    REDIS_URL: redis://localhost:6379
  ```

- [ ] **Step 4: 冒烟**

  - `pnpm dev:db:up && pnpm dev:server-main` 走 redis lock
  - `pnpm test` 跑 memory + redis 两套

**Acceptance**:
- 单 e2e suite 覆盖 memory + redis 两套，全绿
- CI 同时启动 postgres + redis，e2e 全绿

---

## Track C — Docker 化

### Task C1: `apps/server-main/Dockerfile`

**Files**:
- Create: `apps/server-main/Dockerfile`
- Create: `.dockerignore`（根，C4 覆盖；本任务先做最小版）

- [ ] **Step 1: Multi-stage Dockerfile**

  参见 spec §5.1。三段：deps / build / runtime。Runtime 用 `node:22-alpine` + `pnpm` + 仅 prod deps。

- [ ] **Step 2: 最小 `.dockerignore`**

  ```
  node_modules
  **/node_modules
  dist
  **/dist
  .next
  **/.next
  .turbo
  coverage
  .env*
  .git
  ```

- [ ] **Step 3: build smoke**

  ```bash
  docker build -f apps/server-main/Dockerfile -t meshbot/server-main:local .
  ```

  期望 image < 300MB。`docker run --rm meshbot/server-main:local node --version` 验证 runtime 起得来。

- [ ] **Step 4: 起 image 跑健康检查**

  ```bash
  docker run --rm -p 3200:3200 \
    -e DATABASE_URL=postgresql://meshbot:meshbot@host.docker.internal:5432/meshbot_main \
    -e JWT_SECRET=local-test \
    meshbot/server-main:local
  # 另一个终端
  curl http://localhost:3200/api/health
  ```

  应返回 `{"status":"up", ...}`。

**Acceptance**:
- `docker build` 成功，image < 300MB
- `docker run` 后 health endpoint 返回 200
- `docker run` migration 自动跑（dev 路径），register / login 端点可用（手测）

---

### Task C2: `apps/server-agent/Dockerfile`

**Files**:
- Create: `apps/server-agent/Dockerfile`

- [ ] **Step 1: Multi-stage**

  build stage 装 `python3 / make / g++` 给 `better-sqlite3` 编 native；runtime stage 装 `sqlite-libs`。

  ```dockerfile
  FROM node:22-alpine AS build
  RUN apk add --no-cache python3 make g++ libc6-compat
  RUN corepack enable
  WORKDIR /repo
  COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
  COPY apps/server-agent/package.json apps/server-agent/
  COPY libs/common/package.json libs/common/
  COPY libs/agent/package.json libs/agent/
  COPY libs/types/package.json libs/types/
  COPY libs/types-agent/package.json libs/types-agent/
  RUN pnpm install --frozen-lockfile
  COPY . .
  RUN pnpm --filter @meshbot/types build
  RUN pnpm --filter @meshbot/common build
  RUN pnpm --filter @meshbot/types-agent build
  RUN pnpm --filter @meshbot/agent build
  RUN pnpm --filter @meshbot/server-agent build

  FROM node:22-alpine AS runtime
  RUN apk add --no-cache sqlite-libs
  RUN corepack enable
  WORKDIR /app
  ENV NODE_ENV=production MESHBOT_HOME=/data
  VOLUME ["/data"]
  COPY --from=build /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml /repo/package.json ./
  COPY --from=build /repo/apps/server-agent ./apps/server-agent
  COPY --from=build /repo/libs ./libs
  RUN pnpm install --frozen-lockfile --prod
  EXPOSE 3100
  HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3100/health || exit 1
  CMD ["node", "apps/server-agent/dist/main.js"]
  ```

- [ ] **Step 2: build smoke + run smoke**

  ```bash
  docker build -f apps/server-agent/Dockerfile -t meshbot/server-agent:local .
  docker run --rm -p 3100:3100 -v meshbot-agent-data:/data meshbot/server-agent:local
  ```

  health endpoint 验证 + sqlite db 自动建在 `/data/agent.db`。

**Acceptance**:
- build 成功，image < 350MB（含 sqlite-libs）
- 容器内 `/data/agent.db` 自动建表（迁移跑过）
- health endpoint 200

---

### Task C3: `infra/prod/docker-compose.prod.yml`

**Files**:
- Create: `infra/prod/docker-compose.prod.yml`
- Create: `infra/prod/.env.prod.example`
- Create: `infra/prod/README.md`

- [ ] **Step 1: compose 编排**

  ```yaml
  services:
    postgres:
      image: postgres:16-alpine
      env_file: .env.prod
      volumes: [postgres-data:/var/lib/postgresql/data]
      healthcheck:
        test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
        interval: 5s
        retries: 10
    redis:
      image: redis:7-alpine
      volumes: [redis-data:/data]
      healthcheck:
        test: ["CMD", "redis-cli", "ping"]
        interval: 5s
    server-main:
      build:
        context: ../..
        dockerfile: apps/server-main/Dockerfile
      depends_on:
        postgres: { condition: service_healthy }
        redis: { condition: service_healthy }
      env_file: .env.prod
      ports: ["3200:3200"]
      restart: unless-stopped
  volumes:
    postgres-data:
    redis-data:
  ```

- [ ] **Step 2: env.prod.example**

  ```
  POSTGRES_USER=meshbot
  POSTGRES_PASSWORD=<change-me>
  POSTGRES_DB=meshbot_main
  DATABASE_URL=postgresql://meshbot:<change-me>@postgres:5432/meshbot_main
  REDIS_URL=redis://redis:6379
  JWT_SECRET=<change-me-32-bytes>
  JWT_EXPIRES=7d
  NODE_ENV=production
  PORT=3200
  ```

- [ ] **Step 3: README**

  - 「如何起 prod 编排」
  - 「环境变量清单」
  - 「数据库备份提醒」
  - 「日志查看」（`docker compose -f infra/prod/docker-compose.prod.yml logs -f server-main`）

- [ ] **Step 4: 冒烟**

  ```bash
  cd infra/prod && cp .env.prod.example .env.prod && vi .env.prod  # 改 secret
  docker compose -f docker-compose.prod.yml up -d
  curl http://localhost:3200/api/health
  ```

**Acceptance**:
- 编排起来 < 1 分钟
- server-main 健康检查绿（postgres + redis depend_on 成立）
- 数据库迁移自动跑（migrationsRun 在 production 路径需求：spec §1 未要求 production migrationsRun，C3 step 4 检查 production 配置 —— 默认 `migrationsRun: false`，启动后手动 `pnpm migration:run:main` via exec）

---

### Task C4: 根 `.dockerignore` 完整化 + CI image build smoke

**Files**:
- Modify: `.dockerignore`（根，完整化）
- Modify: `.github/workflows/ci.yml`（加 docker build smoke job 或 step）

- [ ] **Step 1: 根 `.dockerignore` 完整化**

  ```
  node_modules
  **/node_modules
  dist
  **/dist
  .next
  **/.next
  .turbo
  **/.turbo
  coverage
  **/coverage
  .git
  .github
  docs
  .claude
  .cursor
  .husky
  .vscode
  .DS_Store
  *.log
  .env*
  release
  **/release
  out
  **/out
  tsconfig.tsbuildinfo
  **/tsconfig.tsbuildinfo
  ```

- [ ] **Step 2: CI 加 docker build smoke**

  `ci.yml` 加一个 job（或 step，建议独立 job 走 matrix）：

  ```yaml
  docker-build:
    runs-on: ubuntu-latest
    needs: ci
    strategy:
      matrix:
        target: [server-main, server-agent]
    steps:
      - uses: actions/checkout@v6
      - uses: docker/setup-buildx-action@v3
      - run: docker build -f apps/${{ matrix.target }}/Dockerfile -t meshbot/${{ matrix.target }}:ci .
  ```

  不 push，仅验证 Dockerfile 可 build。

- [ ] **Step 3: 验证**

  - PR 触发 → 看 docker-build job 是否都过
  - 失败时 image 体积超出？或 native module 编译失败？按错误修

**Acceptance**:
- 根 `.dockerignore` 排除 5 类垃圾（node_modules/dist/coverage/git/docs）
- CI docker-build job 两个矩阵都绿
- image build 时间 < 5 分钟

---

## Track D — 发布工具链

### Task D1: Changesets 接入

**Files**:
- Create: `.changeset/config.json`
- Create: `.changeset/README.md`（changesets 自带模板）
- Modify: `package.json`（加 dev dep `@changesets/cli` + scripts）
- Create: `CONTRIBUTING.md`（A3 占位回填）

- [ ] **Step 1: 安装**

  ```bash
  pnpm add -Dw @changesets/cli
  pnpm changeset init
  ```

- [ ] **Step 2: 配置**

  `.changeset/config.json`：

  ```json
  {
    "$schema": "https://unpkg.com/@changesets/config/schema.json",
    "changelog": "@changesets/cli/changelog",
    "commit": false,
    "fixed": [["@meshbot/cli-agent", "@meshbot/desktop"]],
    "linked": [],
    "access": "public",
    "baseBranch": "main",
    "updateInternalDependencies": "patch",
    "ignore": [
      "@meshbot/web-agent",
      "@meshbot/web-main",
      "@meshbot/server-agent",
      "@meshbot/server-main",
      "@meshbot/agent",
      "@meshbot/common",
      "@meshbot/main",
      "@meshbot/types",
      "@meshbot/types-agent",
      "@meshbot/types-main"
    ]
  }
  ```

  注：`ignore` 含所有内部 / 私有包；只发 `cli-agent` + `desktop` 走公开 npm。

- [ ] **Step 3: 根 package.json scripts**

  ```json
  "changeset": "changeset",
  "version-packages": "changeset version",
  "release": "changeset publish"
  ```

- [ ] **Step 4: CONTRIBUTING.md 写「如何加 changeset」**

  ```markdown
  ## 提交 PR 前加 changeset

  涉及 cli-agent / desktop 改动的 PR 必须含 changeset：

  pnpm changeset
  # 选择哪些包受影响 / bump 级别（patch/minor/major）/ 写变更说明
  git add .changeset/<random>.md && git commit
  ```

**Acceptance**:
- `pnpm changeset` 交互式生成 `.changeset/<random>.md`
- `pnpm changeset status` 报告当前累计变更
- `pnpm changeset version` 本地试跑：把 changeset 转成 package.json bump + CHANGELOG.md

---

### Task D2: `.github/workflows/release.yml`

**Files**:
- Create: `.github/workflows/release.yml`
- Modify: GitHub Settings（开 `GITHUB_TOKEN` write 权限 + PR 创建权限）—— 文档化即可

- [ ] **Step 1: workflow 主体**

  ```yaml
  name: Release
  on:
    push:
      branches: [main]
  permissions:
    contents: write
    pull-requests: write
  concurrency:
    group: release
    cancel-in-progress: false
  jobs:
    release:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v6
          with: { fetch-depth: 0 }
        - uses: pnpm/action-setup@v6
        - uses: actions/setup-node@v6
          with:
            node-version: 22
            cache: pnpm
            registry-url: "https://registry.npmjs.org"
        - run: pnpm install --frozen-lockfile
        - uses: changesets/action@v1
          with:
            version: pnpm version-packages
            publish: pnpm release  # changeset publish
            createGithubReleases: true
            commit: "chore: release packages"
            title: "chore: release packages"
          env:
            GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
            NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  ```

- [ ] **Step 2: 流程文档化**

  CONTRIBUTING.md 补：

  - PR 加 changeset → 合并到 main → release.yml 自动开 Version PR → 合并 Version PR → release.yml 自动 publish + 创建 GitHub release + git tag

- [ ] **Step 3: 测试（用一个空变更）**

  在 fork 或 staging 仓库试跑一次完整流程：开 changeset PR → 合并 → Version PR → 合并 → npm publish。

  生产仓库首次落地建议在「下一次小修补」搭车试。

**Acceptance**:
- release workflow 在 main 上自动跑
- 累计 changeset 后开 Version PR
- Version PR 合并后自动 publish + 打 tag

---

### Task D3: 重构 `package-desktop.yml` / `publish-cli.yml` 对齐 changesets tag

**Files**:
- Modify: `.github/workflows/package-desktop.yml`
- Modify: `.github/workflows/publish-cli.yml`

- [ ] **Step 1: tag 格式对齐**

  Changesets 默认生成的 tag 是 `@meshbot/cli-agent@1.2.0` 形式（含 `@` 与 `/`，shell 不友好），可在 `config.json` 加 `"tag": "tagPrefix"` 选项或在 release workflow 里用 `changeset tag` + 自定义 mapper。

  推荐做法：保留现有 `cli@X.Y.Z` / `app@X.Y.Z` 短 tag 格式，release workflow 里手工生成短 tag 推上去（一行 shell）：

  ```yaml
  - name: Generate short tags
    run: |
      VERSION=$(jq -r .version apps/cli-agent/package.json)
      git tag "cli@${VERSION}"
      git push origin "cli@${VERSION}"
      # desktop 同理
  ```

  既保留下游 workflow 的触发器不变，又用 changesets 管 source of truth。

- [ ] **Step 2: 复用 CI 步骤（reusable workflow）**

  把 install / build / typecheck / test 抽到 `.github/workflows/_setup.yml`（reusable workflow，用 `workflow_call` 触发）。`ci.yml` / `package-desktop.yml` / `publish-cli.yml` / `release.yml` 通过 `uses: ./.github/workflows/_setup.yml` 复用。

- [ ] **Step 3: artifact 上传 GitHub Release**

  `package-desktop.yml` 末尾：

  ```yaml
  - uses: softprops/action-gh-release@v2
    with:
      tag_name: ${{ github.ref_name }}
      files: |
        release/**/*.dmg
        release/**/*.exe
        release/**/*.AppImage
  ```

**Acceptance**:
- 改造后 push `cli@<v>` 仍触发 `publish-cli.yml`
- changesets release.yml 在合并 Version PR 后自动生成短 tag，下游 workflow 被触发
- desktop 产物自动上传到 GitHub Release

---

### Task D4: README 安装说明 + CHANGELOG 模板

**Files**:
- Modify: `README.md`
- Create: `apps/cli-agent/CHANGELOG.md`（changesets 自动维护，先建空文件）
- Create: `apps/desktop/CHANGELOG.md`

- [ ] **Step 1: README「下载与安装」section**

  ```markdown
  ## 下载与安装

  - **桌面端（desktop）**：从 [Releases](https://github.com/<org>/meshbot/releases) 下载对应平台安装包
    - macOS: `meshbot-<version>-arm64.dmg` / `meshbot-<version>-x64.dmg`
    - Windows: `meshbot-<version>-x64.exe`
    - Linux: `meshbot-<version>.AppImage`
  - **CLI（cli-agent）**：`npm i -g @meshbot/cli-agent`
  ```

- [ ] **Step 2: CHANGELOG.md 占位**

  `apps/cli-agent/CHANGELOG.md` 与 `apps/desktop/CHANGELOG.md` 创建空文件（changesets 首次 release 会自动追加）。

- [ ] **Step 3: 根 CHANGELOG.md 索引**

  ```markdown
  # CHANGELOG

  本仓库使用 [changesets](https://github.com/changesets/changesets) 管理变更。各包 changelog：

  - [@meshbot/cli-agent](apps/cli-agent/CHANGELOG.md)
  - [@meshbot/desktop](apps/desktop/CHANGELOG.md)
  ```

**Acceptance**:
- README 含完整下载链接与 npm 安装命令
- 3 个 CHANGELOG 文件就位

---

## Track E2 — Pre-commit 并行化

### Task E2: `.husky/pre-commit` 并行 fence

**Files**:
- Modify: `package.json`（加 `check:parallel`）
- Modify: `.husky/pre-commit`

- [ ] **Step 1: 加并行 script**

  ```json
  "check:parallel": "pnpm run --parallel \"/^check:(tx|naming|lock-tx|repo|dead)$/\""
  ```

  或如果 pnpm 版本不支持正则，列出来：

  ```json
  "check:parallel": "pnpm --parallel run check:tx run check:naming run check:lock-tx run check:repo run check:dead"
  ```

- [ ] **Step 2: pre-commit 切到并行**

  ```bash
  echo "[pre-commit] running 5 static fences (parallel)..."
  pnpm check:parallel
  ```

- [ ] **Step 3: 计时验证**

  ```bash
  time bash .husky/pre-commit
  ```

  目标 ≤ 25 秒（基线 ~35-45s）。

- [ ] **Step 4: 输出可读性**

  并行输出会乱。`pnpm run --parallel` 默认每行加 prefix（如 `check:tx |`），可读性 OK。如果不行回退串行 + 关注真正瓶颈。

**Acceptance**:
- `time pnpm check:parallel` < 15 秒
- pre-commit 整体 ≤ 25 秒
- 5 fence 都跑过、findings 准确

---

## Phase 4 完工验收清单

执行完所有任务后：

```bash
# 1. 静态围栏（strict 模式）
pnpm typecheck
pnpm check:strict
pnpm sync:locales -- --check
pnpm sync:skills -- --check

# 2. 测试（双 provider）
pnpm dev:db:up   # 启 postgres + redis（B4 后）
pnpm test

# 3. 本地 docker 编排
docker build -f apps/server-main/Dockerfile -t meshbot/server-main:local .
docker build -f apps/server-agent/Dockerfile -t meshbot/server-agent:local .
cd infra/prod && cp .env.prod.example .env.prod  # 改 secret
docker compose -f docker-compose.prod.yml up -d
curl http://localhost:3200/api/health  # 期望 200

# 4. CI 验证
# 推 PR → ci.yml 自动跑 → 全绿

# 5. 发布流程演练（在 staging fork 或一次小修补 PR 上）
pnpm changeset                    # 加 changeset
# PR merge → release.yml 自动开 Version PR
# Version PR merge → release.yml publish npm + push tags
# 短 tag → package-desktop.yml / publish-cli.yml 自动构建 + 上传

# 6. pre-commit 计时
time bash .husky/pre-commit       # 期望 ≤ 25s
```

**退出标志**（与 spec §1.4 / §9 一致）：以上全部满足 → 更新 `CLAUDE.md` 标记 Phase 4 ✅ 已完成，Phase 5 backlog 更新。

---

## 风险与缓解（执行期监控）

| 风险 | 缓解 |
|---|---|
| A0 修 server-agent baseline 牵动既有 e2e | 仅删 `@Transactional()` 装饰器，行为不变；跑 server-agent 既有测试套验证 |
| ioredis 版本与 NestJS 11 / TypeScript 5 类型冲突 | 锁 ioredis ^5；如类型不齐用 `as Redis` 临时；B1 单测必须能 import + 实例化 |
| Docker build 在 CI 超时 | matrix 拆分；buildx cache（GitHub Actions cache action） |
| better-sqlite3 在 alpine 编译失败 | runtime 装 sqlite-libs；build 装 libc6-compat + python3 + make + g++ |
| changesets 与现有 short tag (`cli@x.y.z`) 触发器冲突 | D3 用 release workflow 手动生成短 tag，保留下游 trigger 不动 |
| Redis 单连接生命周期 / shutdown 时悬挂 | server-main `onApplicationShutdown` 关 redis client |
| 并行 fence 时机偶发 race | 5 个 fence 都只读 + 写各自 audit dir，互不冲突；如出现 race 退回串行 |

---

## 下一步

本 plan 通过后，按依赖图顺序进入实施。开发者每完成一个 task：

1. 跑该 task 的 acceptance 检查
2. `pnpm check` + `pnpm test`（局部 / 全部）
3. 单独 commit（消息体含 task ID，例如 `feat: A1 — GitHub Actions ci.yml 主流水线`）

完成全 17 task 后跑 §"Phase 4 完工验收清单"，更新 CLAUDE.md → Phase 5。
