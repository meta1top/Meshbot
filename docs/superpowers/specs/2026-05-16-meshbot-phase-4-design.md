# meshbot Phase 4：CI/CD + Redis + Docker + 发布工具链

- 日期：2026-05-16
- 范围：meshbot Phase 4（继 Phase 3 server-main 框架基线之后）
- 形态：一份大 spec，内部 5 个 track（CI 起手，其它并行 / 按需推进）
- 不含：监控接入（Sentry / OTel —— 用户明确推迟）；业务迭代（meshbot 自行设计）

---

## 1. 总体目标与范围

### 1.1 目标

把 meshbot **从"本地能跑 + 框架完备"**推到 **"可以持续交付"**：
- 仓库每个 PR 都被 CI 验证（围栏 / 测试 / build）
- `@WithLock` / `@Cacheable` 在生产形态有 Redis 落地
- server-main / server-agent 可 Docker 化部署
- desktop / cli-agent 发布走自动化版本号 + changelog 链路
- 同步清掉 Phase 3 遗留小琐事

### 1.2 五条 track

| Track | 主题 | 估算 task | 关键依赖 |
|------|------|-----------|----------|
| **A** | CI/CD（GitHub Actions）—— PR 验证主流水线 | 3 | 无（起手） |
| **B** | Redis Provider 切换（`@WithLock` / `@Cacheable`） | 4 | A（CI 需要在 PR 中跑 redis 服务） |
| **C** | Docker 化（server-main / server-agent production 镜像） | 4 | A（CI 跑 image build smoke） |
| **D** | 发布工具链（changesets + electron-builder 收口 + cli-agent publish 收口） | 4 | A（release workflow 借 CI 复用 steps） |
| **E** | Phase 3 小琐事收尾 | 2 | 无 |

合计 ~17 task。Track A 优先；B/C/D 可在 A 落地后并行推进；E 散打。

### 1.3 不在范围

- ❌ **监控接入**（Sentry / OTel / Grafana / Prometheus）—— 用户明确推迟到 Phase 5+
- ❌ **业务迭代**（云端协同业务模型）—— meshbot 自行设计，本 Phase 不规划
- ❌ **k8s / Helm Chart** —— Phase 4 只到 Dockerfile + docker-compose 编排，集群部署 Phase 5+
- ❌ **生产 Redis 高可用**（哨兵 / 集群）—— Phase 4 只解决"切到 Redis"，单点 Redis 足够；HA Phase 5+
- ❌ **CDN / 镜像加速分发**（OSS / Cloudflare）—— Phase 5+
- ❌ **多环境隔离**（dev / staging / prod 完整链路） —— Phase 5+，本 Phase 仅 `dev` + `prod` 二档

### 1.4 Phase 4 退出标志

1. PR 触发 GitHub Actions：lint + typecheck + 5 围栏 + sync:* + test 全绿
2. server-main 启动时按 `REDIS_URL` env 自动切 RedisProvider（无 env 则 MemoryProvider 兜底）
3. `docker compose -f infra/prod/docker-compose.prod.yml up` 起 Postgres + Redis + server-main
4. `pnpm changeset` 走 PR-driven 版本号 + changelog 自动化
5. `cli@<version>` / `app@<version>` tag push 后 release workflow 自动产出 desktop dmg/exe + cli-agent npm publish
6. 小琐事 burn down：`ts-jest isolatedModules` 警告消除 / pre-commit ≤ 25s

---

## 2. 资产矩阵

### 2.1 Track A — CI/CD（3 task）

| # | 资产 | Phase 4 动作 |
|---|------|--------------|
| A1 | `.github/workflows/ci.yml` | 主流水线：PR + `push` to main 触发；Linux + Node 22；steps：install → lint → typecheck → check（5 围栏） → sync:skills/sync:locales → test。Postgres + Redis 走 `services:` 起容器（B/C 落地后自动覆盖）。 |
| A2 | `.github/workflows/ci.yml` matrix | OS matrix（Linux only，跨平台留给 release workflow）；Node 22 固定（与 `engines` 对齐） |
| A3 | `README.md` + `CONTRIBUTING.md` | 文档 CI badge + 本地复刻 CI 的命令清单 |

### 2.2 Track B — Redis Provider（4 task）

| # | 资产 | Phase 4 动作 |
|---|------|--------------|
| B1 | `libs/common/src/lock/redis-lock.provider.ts` | 基于 `ioredis` + Redlock 算法（单点变体）实现 `LockProvider`；TTL + waitMs + 释放幂等 |
| B2 | `libs/common/src/cache/redis-cache.provider.ts` | 基于 `ioredis` 实现 `CacheProvider`；SET PX TTL；DEL on evict；JSON 序列化 |
| B3 | server-main / server-agent 接入 | `CommonModule.forRoot({ lock: env.REDIS_URL ? new RedisLockProvider(...) : "memory", cache: 同理 })`；config 验证 |
| B4 | dev / prod docker-compose 加 redis 容器 + 单测 + e2e 覆盖 RedisProvider 路径 | `infra/dev/docker-compose.dev.yml` 加 redis；测试套用 `REDIS_URL=` 跑 Redis 路径 |

### 2.3 Track C — Docker 化（4 task）

| # | 资产 | Phase 4 动作 |
|---|------|--------------|
| C1 | `apps/server-main/Dockerfile` | Multi-stage：deps → build → runtime（node:22-alpine slim）；只装 prod deps；HEALTHCHECK |
| C2 | `apps/server-agent/Dockerfile` | 同 C1，better-sqlite3 native module 用 alpine + python3 + make 构建；运行时仅 alpine |
| C3 | `infra/prod/docker-compose.prod.yml` | 编排 postgres + redis + server-main；env 注入；volume 持久化；端口暴露 |
| C4 | `.dockerignore` + 镜像 smoke 测 | 减小 context；CI 跑 `docker build` smoke（不 push） |

### 2.4 Track D — 发布工具链（4 task）

| # | 资产 | Phase 4 动作 |
|---|------|--------------|
| D1 | `.changeset/config.json` + `pnpm changeset` 流程 | 版本号策略：`fixed: ["@meshbot/agent", "@meshbot/desktop"]`（保持同 tag）；其它包 `linked`；private 包 `ignore` |
| D2 | `.github/workflows/release.yml` | PR-driven：merge changeset PR → workflow 跑 `changeset version` + 自动 PR；tag push 触发实际发布 |
| D3 | `package-desktop.yml` / `publish-cli.yml` 重构 | 复用 CI 的 install/test/build 步骤；触发器与 changesets 对齐；artifact 上传 GitHub Release |
| D4 | `CHANGELOG.md` 模板 + `README.md` 安装说明 | 每个发布包一份 CHANGELOG；README 加最新 release 链接 |

### 2.5 Track E — Phase 3 小琐事（2 task）

| # | 资产 | Phase 4 动作 |
|---|------|--------------|
| E1 | `tsconfig.base.json` + `jest.config.ts` | 把 `isolatedModules: true` 从 ts-jest transformer 选项迁移到 tsconfig compilerOptions（消除 ts-jest v30 弃用警告） |
| E2 | `.husky/pre-commit` 调优 | 并行化 fences（`pnpm check` 内部串行 → 改并行）；目标 ≤ 25s（当前 ~30-40s） |

---

## 3. Track A 详细设计（CI/CD）

### 3.1 主流水线 `.github/workflows/ci.yml`

**触发器**：

```yaml
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
```

**Job 结构**：

- 单 job `ci`，runs-on `ubuntu-latest`，Node 22 固定（matches `package.json` 假定）
- 显式 `services:` 启动 Postgres 16 + Redis 7（Track B/C 落地后默认启动；Phase 4a 阶段 Redis 可暂关）
- pnpm cache（`actions/setup-node@v6` with `cache: pnpm`）+ Turbo remote cache（可选，默认本地）

**Steps**（顺序与 pre-commit 对齐）：

```yaml
- uses: actions/checkout@v6
- uses: pnpm/action-setup@v6
- uses: actions/setup-node@v6
  with: { node-version: 22, cache: pnpm }
- run: pnpm install --frozen-lockfile
- run: pnpm lint
- run: pnpm typecheck
- run: pnpm check            # 5 围栏（strict 模式，CI 用 --strict）
- run: pnpm sync:skills -- --check
- run: pnpm sync:locales -- --check
- run: pnpm test
- run: pnpm build            # turbo build 全包
```

**CI vs pre-commit 差异**：

- pre-commit 用增量 baseline；CI 用 `--strict`（不允许 baseline，所有 finding 都阻断）。这意味着 Phase 3 残留的 1 个 server-agent `auth.service.ts` REDUNDANT @Transactional finding 必须在 CI 启用 strict 前先修
- CI 跑 e2e（需 Postgres service）；pre-commit 跳过 e2e

**E2E 在 CI**：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env: { POSTGRES_USER: meshbot, POSTGRES_PASSWORD: meshbot, POSTGRES_DB: meshbot_main }
    ports: ["5432:5432"]
    options: --health-cmd="pg_isready -U meshbot" --health-interval=5s --health-timeout=3s --health-retries=5
env:
  DATABASE_URL: postgresql://meshbot:meshbot@localhost:5432/meshbot_main
```

### 3.2 Strict 模式预热

PR 中先开 `pnpm check`（非 strict）→ 合并；下一个 PR 加 `--strict`。需先处理：
- 修 `apps/server-agent/src/services/auth.service.ts:23` REDUNDANT @Transactional（去掉装饰器，单写不需要事务）

### 3.3 README 更新

新增「CI 状态」 badge + 「本地复刻 CI」命令清单（其实就是 `pnpm check` + `pnpm test` + `pnpm build`）。

---

## 4. Track B 详细设计（Redis Provider）

### 4.1 Redis 客户端选型

`ioredis` ——
- 生态最广，TypeScript 类型齐
- 支持单点 / Sentinel / Cluster 三种模式（未来 HA 平滑切换）
- Promise 原生 API

### 4.2 `RedisLockProvider`

**算法**：单点 Redis Redlock 简化版

```ts
// 简化伪码
async acquire(key, ttlMs, waitMs) {
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const ok = await redis.set(key, token, "PX", ttlMs, "NX");
    if (ok === "OK") return () => releaseScript(key, token);
    await sleep(50);
  }
  throw new Error("LOCK_ACQUIRE_FAILED");
}
```

**释放幂等**：用 Lua 脚本 `if redis.call("get", key) == token then redis.call("del", key) end`（防止释放别人的锁）。

**TTL 续期**：Phase 4 不做（业务方法应该足够短，超时直接释放）。如有长时方法需要，后续加 watchdog。

### 4.3 `RedisCacheProvider`

```ts
async get<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}
async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
  await redis.set(key, JSON.stringify(value), "PX", ttlMs);
}
async del(key: string): Promise<void> {
  await redis.del(key);
}
async delByPrefix(prefix: string): Promise<void> {
  // SCAN + DEL；避免 KEYS 阻塞
}
```

**注**：当前 `CacheProvider` 接口需要确认是否含 `delByPrefix`。如果当前 `MemoryCacheProvider` 没有，Redis 版加上、Memory 版补齐（保持接口一致）。

### 4.4 server-main / server-agent 接入

`apps/server-main/src/app.module.ts`：

```ts
imports: [
  ConfigModule.forRoot({ isGlobal: true, envFilePath: [".env.development", ".env"] }),
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
  // ...
]
```

**需扩展 `CommonModule`**：新增 `forRootAsync` 形态接受 factory。当前只有同步 `forRoot`。

### 4.5 dev infra 加 redis

`infra/dev/docker-compose.dev.yml`：

```yaml
services:
  postgres: # 既有
    ...
  redis:
    image: redis:7-alpine
    container_name: meshbot-dev-redis
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
```

`.env.development.example` 加 `REDIS_URL=redis://localhost:6379`（默认注释掉，让开发者选 memory 兜底还是 redis）。

### 4.6 测试

- 单测：`RedisLockProvider` / `RedisCacheProvider` 用 `ioredis-mock` 或真 redis docker 测；覆盖 acquire/release 幂等、TTL 过期、并发竞争、cache get/set/del
- e2e：`auth-flow.spec.ts` 加 `describe.each([["memory"], ["redis"]])` 同样跑 register/login 路径，确保 lock/cache 在 redis 模式下也工作

---

## 5. Track C 详细设计（Docker 化）

### 5.1 `apps/server-main/Dockerfile`

**Multi-stage**：

```dockerfile
# Stage 1: deps
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server-main/package.json apps/server-main/
COPY libs/common/package.json libs/common/
COPY libs/main/package.json libs/main/
COPY libs/types/package.json libs/types/
COPY libs/types-main/package.json libs/types-main/
RUN pnpm install --frozen-lockfile --prod=false  # build needs dev deps

# Stage 2: build
FROM deps AS build
COPY . .
RUN pnpm --filter @meshbot/types build
RUN pnpm --filter @meshbot/common build
RUN pnpm --filter @meshbot/types-main build
RUN pnpm --filter @meshbot/main build
RUN pnpm --filter @meshbot/server-main build

# Stage 3: runtime
FROM node:22-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml /repo/package.json ./
COPY --from=build /repo/apps/server-main/package.json ./apps/server-main/
COPY --from=build /repo/apps/server-main/dist ./apps/server-main/dist
COPY --from=build /repo/libs/*/package.json /repo/libs/*/dist ./libs/
RUN pnpm install --frozen-lockfile --prod
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3200/api/health || exit 1
CMD ["node", "apps/server-main/dist/main.js"]
```

**注意**：
- 不用 `output: standalone` —— NestJS 不像 Next.js 有 standalone 构建
- 把 monorepo workspace 文件全部 copy 进 runtime stage（pnpm 需要它们解析 workspace symlinks）
- 镜像目标 < 200MB

### 5.2 `apps/server-agent/Dockerfile`

类似 C1，但要在 build stage 装 `python3` + `make` + `g++` 给 `better-sqlite3` native 编译，runtime stage 仅 alpine：

```dockerfile
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
# ... 复制 + 构建 ...

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache sqlite-libs   # better-sqlite3 运行依赖
# ...
VOLUME ["/data"]
ENV MESHBOT_HOME=/data
CMD ["node", "apps/server-agent/dist/main.js"]
```

### 5.3 `infra/prod/docker-compose.prod.yml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env_file: .env.prod
    volumes: [postgres-data:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
    volumes: [redis-data:/data]
  server-main:
    build:
      context: ../..
      dockerfile: apps/server-main/Dockerfile
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    env_file: .env.prod
    ports: ["3200:3200"]
volumes:
  postgres-data:
  redis-data:
```

### 5.4 `.dockerignore`

排除 `node_modules` / `dist` / `.next` / `.turbo` / `coverage` / `.env*` / `.git` 等。每个 Dockerfile 都受益。

### 5.5 CI 跑 image build smoke

`ci.yml` 加一个可选 job：

```yaml
- name: Docker build smoke (server-main)
  run: docker build -f apps/server-main/Dockerfile -t meshbot/server-main:ci .
```

不 push，仅验证 Dockerfile 可 build。

---

## 6. Track D 详细设计（发布工具链）

### 6.1 Changesets 接入

`pnpm add -Dw @changesets/cli` → `pnpm changeset init` 生成 `.changeset/`。

`config.json`：

```json
{
  "$schema": "https://unpkg.com/@changesets/config/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [["@meshbot/agent", "@meshbot/desktop"]],
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

`fixed: [["@meshbot/agent", "@meshbot/desktop"]]` —— 两者锁同一 version（meshbot 桌面 + cli 同步发版）。

`ignore` 列私有包（不发 npm）。

### 6.2 Release workflow

`.github/workflows/release.yml`：

```yaml
on:
  push:
    branches: [main]
permissions:
  contents: write
  pull-requests: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm, registry-url: "https://registry.npmjs.org" }
      - run: pnpm install --frozen-lockfile
      - uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm changeset tag
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**流程**：
1. 开发者在 PR 里加 `.changeset/<random>.md`（描述变更 + 影响哪些包 + bump 级别）
2. PR 合并到 main → release workflow 跑 `changeset version` 自动开"Version Packages" PR
3. 该 PR 合并 → workflow 跑 `changeset tag` 自动创建 git tag（如 `cli-agent@1.2.0`）
4. tag push 触发 `package-desktop.yml` / `publish-cli.yml` 实际发布

### 6.3 重构 `package-desktop.yml` / `publish-cli.yml`

- 触发器对齐 changesets 生成的 tag 格式（`@meshbot/agent@x.y.z` 或自定义短 tag）
- 复用 CI 的 install/build/test step（用 reusable workflow 或 composite action）
- artifact 上传 GitHub Release（dmg/exe/AppImage）

### 6.4 文档

- 根 `CHANGELOG.md`（changesets 自维护，加链接到 release page）
- `README.md` 加「下载最新版」section（含 desktop 下载链接 + `npm i -g @meshbot/agent`）
- `CONTRIBUTING.md` 写「如何提交 changeset」

---

## 7. Track E 详细设计（Phase 3 小琐事）

### 7.1 `ts-jest isolatedModules` 警告

当前每跑一次 jest 都打一行：

```
ts-jest[config] (WARN) The "ts-jest" config option "isolatedModules" is deprecated...
```

修复：删 `jest.config.ts` transformer options 里的 `isolatedModules: true`，改加到 `tsconfig.base.json` 的 `compilerOptions.isolatedModules: true`。

ts-jest v30 起从 tsconfig 读，不再从 transformer options 接受。

### 7.2 pre-commit 调优

当前 `pnpm check` 串行 5 个 fence。改为：

```bash
"check:parallel": "pnpm run --parallel \"/^check:[a-z-]+$/\""
```

5 个 fence 用 pnpm 并行跑。预期 ~30s → ~12s。

**风险**：并行时输出顺序乱。可接受（CI 看顺序无意义）。

---

## 8. 风险 / 未决 / Phase 5 衔接

### 8.1 已知风险

| # | 风险 | 缓解 |
|---|------|------|
| R1 | CI 启用 `--strict` 围栏会被 server-agent baseline 阻断 | A 落地前先修 `auth.service.ts:23` REDUNDANT @Transactional |
| R2 | Redis 单点 == 单点故障 | Phase 4 接受；Phase 5 加 Sentinel / Cluster |
| R3 | Docker image 体积超 500MB | 多 stage + prune dev deps + alpine base + 单独验镜像 < 300MB |
| R4 | better-sqlite3 native module 在 alpine 构建慢 / 失败 | build stage 装 python3 + make + g++，runtime stage 装 sqlite-libs |
| R5 | changesets 与现有 `package-desktop.yml` / `publish-cli.yml` 触发器冲突 | D2/D3 同步重构，触发器对齐；过渡期可双跑（旧手工 tag + 新 changesets 各自一份 workflow） |
| R6 | CI 跑 e2e 拉 Postgres image 慢 | github action 服务容器有缓存；接受 1-2 分钟启动开销 |
| R7 | RedisLockProvider 与 MemoryLockProvider 语义不一致（如 TTL 续期）| 文档明确「Memory 忽略 TTL」+ 测试断言两种 provider 行为对齐 |

### 8.2 未决问题

**Phase 4 开始前敲定**：

- Q1：CI Node 版本固定 22 还是 matrix 20/22 → **22 only**（与 release / Docker 对齐）
- Q2：CI 跑 macOS / Windows → **不跑**（CI 只 Linux；release workflow 已经有跨平台 matrix）
- Q3：Turbo remote cache 启用 → **Phase 4 不启用**（本地 + GitHub Actions cache 够用；Phase 5 看是否上 Vercel/自托管）
- Q4：changesets 包含 `@meshbot/server-main` / `@meshbot/server-agent` 吗 → **不包含**（用 Docker 镜像版本号管理，不发 npm）

**Phase 4 实施中**：

- Q5：Redis 集群模式 vs 单点 → **单点**（dev/prod 都用单点，HA 推 Phase 5）
- Q6：cli-agent 发布到公网 npm 还是私有 registry → **公网 npm，public access**（现有 `publish-cli.yml` 已是此形态）

**Phase 5+ 推迟**：

- 监控（Sentry / OTel）
- 多环境（dev / staging / prod）
- k8s / Helm
- Redis HA
- CDN / 镜像分发

### 8.3 Phase 5 衔接（候选）

| Phase 5 候选任务 | Phase 4 准备 |
|------------------|--------------|
| 业务模型（meshbot 自定义） | server-main 框架基线 + CI 全部就绪 |
| Sentry / OTel 监控 | Docker / CI 已搭好，加 SDK 即可 |
| k8s 部署 | Dockerfile + docker-compose 已规范 |
| Redis HA | RedisProvider 已抽象，换实现 |
| 多环境配置 | .env.*.example 已存在，加 staging/prod 分支 |

---

## 9. Phase 4 退出标志（详细）

- ✅ `pnpm typecheck` / `pnpm test` / `pnpm check --strict` / `pnpm sync:locales --check` / `pnpm sync:skills --check` 全通过（含 CI 与本地）
- ✅ `.github/workflows/ci.yml` 在 PR / push main 上自动跑，绿
- ✅ `infra/dev/docker-compose.dev.yml` 含 redis；`.env.development` 设 `REDIS_URL` 后 server-main 跑通 register / login（lock + cache 走 Redis）
- ✅ `docker build -f apps/server-main/Dockerfile .` 成功，image < 300MB；`docker compose -f infra/prod/docker-compose.prod.yml up` 起 server-main 跑通健康检查
- ✅ `pnpm changeset` → 合并 Version PR → tag push → desktop dmg/exe + cli-agent npm 自动发布
- ✅ `ts-jest isolatedModules` 警告消除；pre-commit ≤ 25s
- ✅ CLAUDE.md 标记 Phase 4 ✅ 已完成，Phase 5 backlog 更新

---

## 10. 下一步

本 spec 通过后，进入 **writing-plans skill**，为 Phase 4 撰写详细实施 plan，把 ~17 个 task 展开到可直接进入实施的颗粒度。

实施顺序建议：

1. **Track A**（CI/CD）—— 起手必备
2. **Track E1**（`isolatedModules` 迁移）—— 顺手，1 commit
3. **Track B**（Redis）—— A 落地后并行
4. **Track C**（Docker）—— A/B 落地后并行
5. **Track D**（Release）—— A/C 落地后做（依赖 CI + Docker image）
6. **Track E2**（pre-commit 调优）—— 最后收尾
