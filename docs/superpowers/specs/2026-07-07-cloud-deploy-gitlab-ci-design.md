# 云端轨部署：GitLab CI 自动化（server-main + web-main）设计

- 日期：2026-07-07
- 范围：把 meshbot 云端轨（`server-main` + `web-main`）部署到自建单宿主机，经自建 GitLab CI 自动化：`push main → build 镜像 → push hub.meta1.top → 同机 docker compose up`。
- 不含：本地轨（server-agent / desktop / cli-agent）；MinIO / Nacos / pgvector / redis 等共享基础设施本身的部署（已由 `Meta1/infra` 仓库提供）。

## 1. 背景与现状

**meshbot 仓库（云端轨相关）**
- `apps/server-main`：已有多阶段 `Dockerfile`（配置走 `loadAppConfig`：Nacos 引导或挂载 YAML），健康检查 `/api/health`，全局前缀 `/api`，WS 命名空间 `ws/im`（socket.io，默认路径 `/socket.io`）+ `ws/health`。
- `apps/web-main`：**无 Dockerfile**；`scripts/post-build.mjs` 已按 `output:"standalone"` 编写，但 `next.config.ts` 当前**未开启** standalone。生产设计为**同源反代**（`lib/api.ts` / `im-socket.ts` 的 baseURL 默认空串 → 相对路径 `/api`、`/socket.io`）。
- `infra/prod/docker-compose.prod.yml`：旧版自起 postgres+redis+server-main，需重写。
- 仓库当前 `origin` 指向 GitHub（`meta1top/Meshbot`）；触发 GitLab CI 需另加 GitLab remote。

**自建 infra 仓库（`Meta1/infra`，独立 git）**
- GitLab CE @ `git.meta1.top`，内置 Container Registry @ `hub.meta1.top`（宿主 5005）。
- nginx（容器 `nginx`，在 `meta1` 网络）反代 `*.meta1.top`，泛域名证书 `/etc/letsencrypt/live/meta1.top/`（certbot + cloudflare DNS）。
- 共享服务全部在外部 docker 网络 `meta1` 上，容器名固定：
  - `pgvector:5432`（user `postgres` / pw `changeme` / db `main`，pg17）
  - `redis:6379`（`requirepass changeme-redis`）
  - `nacos:8848`（v2.3.2，已开鉴权 `NACOS_AUTH_ENABLE=true`，元数据存 MySQL）
  - `minio:9000`（S3 API；宿主映射 9100；root `minioadmin` / `changeme123456`）
- GitLab runner：与 GitLab/docker 同宿主的 **shell executor**，具备基础运行环境 + docker + docker compose。

## 2. 关键决策（已确认）

| 维度 | 决策 |
|------|------|
| 部署目标 | **同一宿主机**：deploy 阶段直接在 shell runner 上 `docker compose up -d`，无 SSH |
| server-main 配置来源 | **复用现有 Nacos**：容器只带 `NACOS_*` 引导变量，真实 secret 全在 Nacos |
| PG / Redis | **复用 infra 共享实例**：compose 不自起 DB/Redis，接入 `meta1` 网络按容器名直连 |
| 部署触发 | **push main 自动部署**：`verify → build → deploy` 全自动 |
| 域名 | `bot.meta1.top`（web-main，同源代理 API）/ `api-bot.meta1.top`（桌面端直连 server-main）/ `assets.meta1.top`（MinIO 出口） |
| 镜像分发 | **push 到 hub.meta1.top**：`:$CI_COMMIT_SHORT_SHA` + `:latest`，compose 按 tag 拉（localhost 拉取极快，保留回滚史） |
| 质量门 | **轻量门**：build 前 `pnpm typecheck` + `pnpm check`（静态围栏）；全量单测/e2e 仍由现有 GitHub CI 把关，不重复 |
| DDL 迁移 | **纯手动**：DBA 登机建库 + 按序跑 `apps/server-main/migrations/*.sql`；CI 完全不碰数据库（贴合「服务任何模式不自动建表」约定） |

## 3. 架构与数据流

三域名，同源反代下 server-main 被两个域名前置（同一容器 `meshbot-server-main:3200`）：

```
浏览器 ──https──▶ nginx (*.meta1.top, 泛域名证书, 在 meta1 网络)
  bot.meta1.top       ├─ /            ─▶ meshbot-web-main:3000     (Next standalone SSR)
                      ├─ /api/*       ─▶ meshbot-server-main:3200
                      └─ /socket.io/* ─▶ meshbot-server-main:3200  (WS upgrade, ns=ws/im)
  api-bot.meta1.top   └─ /            ─▶ meshbot-server-main:3200  (桌面端/CLI/本地轨直连, API+WS 全量)
  assets.meta1.top    └─ /            ─▶ minio:9000                (presigned 上传/下载出口)

桌面端/CLI/server-agent ──https──▶ api-bot.meta1.top ─▶ server-main

meta1 网络内: meshbot-server-main ─▶ pgvector:5432 (库 meshbot_main)
                                  ─▶ redis:6379
                                  ─▶ nacos:8848 (启动拉配置)
                                  ─▶ (presigned URL 的 host = assets.meta1.top, 见 §4.5)
```

- **web-main 同源**：build 时 `NEXT_PUBLIC_SERVER_MAIN_URL` 留空（生产 `next.config` 不注入）→ 客户端全走相对路径，nginx 在 `bot.meta1.top` 内同源分发到 server-main，免 CORS。
- **api-bot**：非浏览器客户端（桌面/CLI/本地轨反向通道）用的稳定 API 域名。server-main 已 `enableCors({origin:true})`，跨域 OK。
- **镜像/CI/compose 与域名解耦**：新增域名只体现为 infra 仓库多几个 nginx server 块 + Nacos 多两块配置，不影响镜像与流水线。

## 4. 组件详细设计

### 4.1 web-main 容器化（meshbot 仓库）

**（a）`apps/web-main/next.config.ts` 改动**

```ts
output: "standalone",
outputFileTracingRoot: <monorepo 根的绝对路径>,   // 让 trace 带上 workspace 依赖
```

- `outputFileTracingRoot` 指向 monorepo 根：实现时用 next.config 中实际可用的路径 API 计算（ESM 用 `fileURLToPath(import.meta.url)` 推 `__dirname` 再 `../..`；若 Next loader 转 CJS 则用 `path.resolve(__dirname, "../..")`），验收以「standalone 产物 trace 到 workspace 依赖、容器能启动」为准。
- dev 不受影响：`next dev` 忽略 `output`。既有 `env` 注入逻辑（dev 才注入 `NEXT_PUBLIC_SERVER_MAIN_URL`）保持不变。

**（b）新建 `apps/web-main/Dockerfile`**（对齐 `server-main/Dockerfile` 多阶段结构）

- **deps**：`node:22-alpine` + corepack；copy `pnpm-lock.yaml` `pnpm-workspace.yaml` `package.json` `.pnpmfile.cjs` + web-main 及其 workspace 依赖的各 `package.json`（`web-main` / `web-common` / `design` / `types` / `types-main`，以及它们的传递 workspace 依赖如 `common`——实现时按实际依赖图补全）→ `pnpm install --frozen-lockfile --ignore-scripts`。
- **build**：copy `tsconfig.base.json` + 上述各包源码 → 先 build 产出 dist 的 lib 依赖（`types` / `types-main` 等；`design` / `web-common` 由 Next `transpilePackages` 在 Next build 期编译源码，无需单独 build，实现时按各包 `exports` 指向 dist 还是 src 最终确认）→ `pnpm --filter @meshbot/web-main build`（`next build` + `post-build.mjs` 把 `.next/static` 拷进 standalone）。
- **runtime**：`node:22-alpine`，`WORKDIR /app`，`ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0`；
  - `COPY --from=build <repo>/apps/web-main/.next/standalone ./`（standalone 含 trace 出的 node_modules + `apps/web-main/server.js` + post-build 拷入的 static）
  - `COPY --from=build <repo>/apps/web-main/public ./apps/web-main/public`（standalone 不含 public，需单独拷）
  - `EXPOSE 3000`；`CMD ["node","apps/web-main/server.js"]`
  - **关键**：`HOSTNAME=0.0.0.0`，否则 Next standalone 只绑 localhost，nginx 跨容器打不进来。
  - healthcheck：`wget -qO- http://localhost:3000/ || exit 1`（Next 无内置健康路由，用首页兜底）。

### 4.2 重写 `infra/prod/docker-compose.prod.yml`（meshbot 仓库）

去掉自起 postgres/redis，接入外部 `meta1` 网络复用共享实例：

```yaml
services:
  server-main:
    image: ${REGISTRY_IMAGE}/server-main:${IMAGE_TAG}
    container_name: meshbot-server-main
    restart: unless-stopped
    networks: [meta1]
    environment:
      NODE_ENV: production
      NACOS_SERVER_ADDR: ${NACOS_SERVER_ADDR}   # nacos:8848
      NACOS_NAMESPACE: ${NACOS_NAMESPACE}        # meshbot
      NACOS_USERNAME: ${NACOS_USERNAME}
      NACOS_PASSWORD: ${NACOS_PASSWORD}
      NACOS_DATA_ID: ${NACOS_DATA_ID:-meshbot-server-main.yaml}
      MESHBOT_NODE_ID: ${MESHBOT_NODE_ID:-0}
    # 不暴露宿主端口：nginx 在 meta1 内按容器名反代

  web-main:
    image: ${REGISTRY_IMAGE}/web-main:${IMAGE_TAG}
    container_name: meshbot-web-main
    restart: unless-stopped
    networks: [meta1]
    # 不暴露宿主端口

networks:
  meta1:
    external: true
```

- 一个 secret 都不出现在 compose / `.env.prod`——只有 Nacos 引导变量 + 镜像 tag。
- `server-main` 在 `meta1` 内按容器名解析 `pgvector` / `redis` / `nacos`（这些主机名写在 Nacos 配置里，见 §4.4）。
- `depends_on` 不覆盖外部服务（它们不在本 compose 内）；靠共享服务先行常驻 + server-main 启动重试兜底。

### 4.3 `.gitlab-ci.yml`（meshbot 仓库根，新建）

shell executor，三阶段，仅 `main` 分支：

- **verify**：在 `docker run --rm node:22-alpine` 内 `corepack enable && pnpm install --frozen-lockfile && pnpm typecheck && pnpm check`。挂 pnpm store 卷（如 `-v meshbot-pnpm-store:/pnpm-store` + `PNPM_HOME`）加速重复安装。不依赖宿主 node 版本。
- **build**（两 job 并行）：`echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"` → `docker build -f apps/server-main/Dockerfile`（`build-server-main`）/ `apps/web-main/Dockerfile`（`build-web-main`），tag `$CI_REGISTRY_IMAGE/{server,web}-main:$CI_COMMIT_SHORT_SHA` + `:latest` → push 两个 tag。
- **deploy**：渲染 `infra/prod/.env.prod`（从 GitLab CI/CD 变量：`REGISTRY_IMAGE=$CI_REGISTRY_IMAGE`、`IMAGE_TAG=$CI_COMMIT_SHORT_SHA`、`NACOS_*`、`MESHBOT_NODE_ID`）→ `docker login` → `docker compose -f infra/prod/docker-compose.prod.yml --env-file infra/prod/.env.prod pull && up -d`。`environment: production`。

registry 凭据用 GitLab 内置 `$CI_REGISTRY` / `$CI_REGISTRY_USER` / `$CI_REGISTRY_PASSWORD`（job token 自动注入），无需手配。

### 4.4 nginx 三域名反代（**infra 仓库** `nginx/conf.d/`）

nginx 已在 `meta1` 网络，按容器名反代，不暴露宿主端口。用 `resolver 127.0.0.11 valid=10s` + 变量式 `proxy_pass` 让容器重启后 nginx 不缓存旧 IP。三个域名都复用泛域名证书 `/etc/letsencrypt/live/meta1.top/{fullchain,privkey}.pem`，`:80` 一律 301 到 `:443`。

- **`bot.meta1.top.conf`**（web-main + 同源 API）
  - `location /api/` → `meshbot-server-main:3200`（转发头）
  - `location /socket.io/` → `meshbot-server-main:3200`（WS upgrade 头）
  - `location /` → `meshbot-web-main:3000`（转发头）
- **`api-bot.meta1.top.conf`**（桌面端/CLI/本地轨直连 server-main）
  - `location /` → `meshbot-server-main:3200`（转发头 + WS upgrade，覆盖 `/api` 与 `/socket.io`）
- **`assets.meta1.top.conf`**（MinIO S3 出口）
  - `client_max_body_size 0`（大文件/技能包）
  - `location /` → `minio:9000`，`proxy_set_header Host $host`（**Host 透传**，SigV4 presigned 签名才对得上）

改完在宿主 `docker compose exec nginx nginx -t && nginx -s reload`。

### 4.5 Nacos 配置 + secret 流

- 服务侧只在容器 env 带 `NACOS_*` 引导变量（compose 从 `.env.prod` 注入，`.env.prod` 由 deploy job 从 GitLab CI/CD 变量渲染）。
- 真实配置在 Nacos：namespace `meshbot`，dataId `meshbot-server-main.yaml`，group `DEFAULT_GROUP`，format YAML。照 `apps/server-main/nacos-example.yml` 填，关键值：
  - `database.host: pgvector` / `port: 5432` / `username: postgres` / `password: <pgvector 口令>` / `database: meshbot_main` / `synchronize: false`
  - `redis.host: redis` / `port: 6379` / `password: changeme-redis` / `db: 0`
  - `jwt.secret: <openssl rand -base64 48>` / `expires: 7d`
  - `security.encryption-key: <≥32 字符随机串>`
  - `assets.minio`：`endPoint: assets.meta1.top` / `port: 443` / `useSSL: true` / `accessKey` / `secretKey` / `bucket: meshbot-skills`
    - 原因：`public-share.controller` 返回 **presigned URL**，其 host = MinIO client 的 `endPoint`，必须是公网可达的 `assets.meta1.top`（否则指向内网 `minio:9000`，浏览器下不动）。
  - `webMainBase: https://bot.meta1.top`（拼分享链接）
  - 可选 `email`（阿里云 DirectMail）：不配则邀请码只打服务日志（`LogEmailSender`）。
- **fail-fast**：`server-main` 生产环境若 `jwt.secret` / `security.encryptionKey` 仍是仓库内置 dev 值 → 启动即抛错（漏配 Nacos 的保护）；配了 `redis` 但无 `MESHBOT_NODE_ID` → 拒绝启动。

## 5. 手动准备清单（一次性，不进 CI）

1. **GitLab 仓库**：在 `git.meta1.top` 建 meshbot 仓库，本地加 remote 并推送（`.gitlab-ci.yml` 提交在本仓库；nginx conf 提交在 infra 仓库）。
2. **数据库**：`pgvector` 上 `CREATE DATABASE meshbot_main;` → 按文件名顺序 `psql` 跑 `apps/server-main/migrations/*.sql`。之后每次 schema 变更同样手动登机执行。
3. **MinIO**：建 bucket `meshbot-skills`；建议为 meshbot 单独建 access key（勿用 root），并改掉默认口令 `changeme123456`。
4. **Nacos**：建 namespace `meshbot` + dataId `meshbot-server-main.yaml`，填 §4.5 的值。
5. **GitLab CI/CD 变量**（项目级，敏感项 masked）：`NACOS_SERVER_ADDR=nacos:8848`、`NACOS_NAMESPACE=meshbot`、`NACOS_USERNAME`、`NACOS_PASSWORD`、`MESHBOT_NODE_ID=0`。（`REGISTRY_IMAGE` / `IMAGE_TAG` 由 deploy job 从内置变量推导，无需手配。）
6. **nginx**：infra 仓库加三个 conf 并 reload（§4.4）。
7. **DNS**：`bot` / `api-bot` / `assets`.meta1.top 解析到宿主（泛域名证书已覆盖，无需单独申请）。

## 6. 错误处理与运维

- **健康检查**：server-main `/api/health`（Dockerfile 内置）；web-main 首页兜底。
- **回滚**：重跑历史 SHA 的 pipeline，或手动 `IMAGE_TAG=<旧 sha> docker compose ... up -d`（registry 保留镜像史）。
- **DNS 稳定性**：nginx `resolver 127.0.0.11 valid=10s` + 变量 `proxy_pass`，避免 meshbot 容器重启换 IP 后 nginx 持旧 IP 502。
- **并发**：单 shell runner，deploy job 天然串行；如需可加 `resource_group: production` 防并发部署。
- **首启依赖**：共享 pgvector/redis/nacos/minio 需先常驻；server-main 靠启动连接重试兜底短暂不可用。

## 7. 明确不做（YAGNI / out of scope）

- 不引入 K8s / Swarm；单宿主 compose 足够。
- 不做蓝绿/金丝雀；`up -d` 滚动替换 + 回滚即可。
- CI 不跑全量单测/e2e（GitHub CI 已覆盖），不跑 DDL 迁移。
- 不部署本地轨（server-agent/desktop/cli-agent）。
- 不在本方案内改造 MinIO/Nacos/pgvector/redis 本身（infra 仓库职责）。
- server-main / web-main 暂不做多副本（`MESHBOT_NODE_ID` 预留；如上多副本再逐副本配唯一 node id + `deploy.replicas`）。

## 8. 验收标准

1. `push main` 后 GitLab pipeline `verify → build → deploy` 全绿，registry 出现两个新 `:$SHA` 镜像。
2. `https://bot.meta1.top` 打开 web-main 页面，登录/注册走通（`/api/*` 同源、`/socket.io` WS 连上）。
3. `https://api-bot.meta1.top/api/health` 返回健康；桌面端/CLI 能用该域名连云端（含 WS）。
4. 分享下载：`public-share` 返回的 presigned URL 指向 `https://assets.meta1.top/...` 且浏览器可直接下载。
5. server-main 启动日志无 dev-secret fail-fast、无 Nacos 拉取失败；DB 连到 `meshbot_main`。

## 9. 风险与注意

- **standalone 路径 / trace**：monorepo 下 `outputFileTracingRoot` 与 workspace 依赖追踪是最易踩坑处，实现时以「容器实际启动 + 页面渲染」验证，而非只看 build 成功。
- **presigned 与 nginx**：`assets.meta1.top` 必须 Host 透传且与 Nacos 里 `assets.minio.endPoint` 一致，否则 SigV4 校验失败（403）。
- **Nacos 鉴权**：infra 的 Nacos 已开鉴权，`NACOS_USERNAME/PASSWORD` 必须对；namespace `meshbot` 需先在控制台创建（用其 namespace id 而非名字，视客户端而定，实现时确认）。
- **仓库双 remote**：GitHub 仍是主 origin；GitLab 仅为 CI/部署，注意推送目标别搞混。
- **shell runner 权限**：runner 用户需在 docker 组（能 `docker` / `docker compose`），且能访问 infra 的 `meta1` 网络与 `/etc/letsencrypt`（后者仅 nginx 需要，runner 不需要）。
