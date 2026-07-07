# 云端轨 GitLab CI 部署 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `push main` 到自建 GitLab 后，自动 `verify → build → deploy` 把 `server-main` + `web-main` 部署到同宿主机，经 nginx 三域名对外，复用 infra 共享 pgvector/redis/nacos/minio。

**Architecture:** shell runner 上 `docker build` 两镜像 → push `hub.meta1.top` → 同机 `docker compose up -d`（接入外部网络 `meta1` 复用共享服务）。server-main 配置走 Nacos，web-main 走 Next standalone + 同源反代。nginx 三域名：`bot`（web-main+同源 API）/ `api-bot`（桌面直连 server-main）/ `assets`（MinIO presigned 出口）。

**Tech Stack:** Node 22 / pnpm（frozen lockfile）/ Next 16 standalone / NestJS / Docker + docker compose / GitLab CI（shell executor）/ nginx / Nacos v2.3.2 / MinIO / Postgres(pgvector) / Redis。

**Spec:** `docs/superpowers/specs/2026-07-07-cloud-deploy-gitlab-ci-design.md`

**跨仓库注意：** Task 1–3、5（文件）在 meshbot 仓库（当前 worktree）；Task 4 在 **infra 仓库** `/Users/grant/Meta1/infra`（独立 git，附加工作目录）；Task 6–7 在部署宿主机 / GitLab 上执行。

## Global Constraints

- 运行时基础镜像 `node:22-alpine`；一律 `pnpm install --frozen-lockfile`。
- 外部 docker 网络固定名 `meta1`（`external: true`），共享容器名固定：`pgvector`(5432) / `redis`(6379,pw `changeme-redis`) / `nacos`(8848,已开鉴权) / `minio`(内部 9000)。
- **真实 secret（DB/JWT/加密key/邮件/MinIO 凭据）只存 Nacos**（dataId `meshbot-server-main.yaml`，namespace `meshbot`）；compose / `.env.prod` / CI 变量里只有 Nacos 引导变量 + 镜像 tag。
- **CI 不碰数据库**：DDL 由 DBA 手动执行；服务任何模式不自动建表。
- 流水线**仅 `main` 分支**触发。
- web-main 生产为**同源**：build 时不设 `NEXT_PUBLIC_SERVER_MAIN_URL`（客户端走相对路径）。
- server-main 生产 fail-fast：`jwt.secret` / `security.encryptionKey` 不得为仓库内置 dev 值；配了 `redis` 必须给 `MESHBOT_NODE_ID`。
- 提交信息用中文，conventional commits 风格，结尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 域名：`bot.meta1.top` / `api-bot.meta1.top` / `assets.meta1.top`，均复用泛域名证书 `/etc/letsencrypt/live/meta1.top/{fullchain,privkey}.pem`。

## 文件结构

meshbot 仓库：
- Modify `apps/web-main/next.config.ts` — 开 standalone + tracing root（Task 1）
- Create `apps/web-main/Dockerfile` — web-main 多阶段镜像（Task 1）
- Modify `infra/prod/docker-compose.prod.yml` — 重写为复用共享服务 + registry 镜像（Task 2）
- Modify `infra/prod/.env.prod.example` — 新变量集（Task 2）
- Create `.gitlab-ci.yml` — verify/build/deploy 流水线（Task 3）
- Create `infra/prod/DEPLOY.md` — 一次性手动准备 runbook（Task 5）

infra 仓库（`/Users/grant/Meta1/infra`）：
- Create `nginx/conf.d/bot.meta1.top.conf`（Task 4）
- Create `nginx/conf.d/api-bot.meta1.top.conf`（Task 4）
- Create `nginx/conf.d/assets.meta1.top.conf`（Task 4）

---

### Task 0: worktree 依赖安装（让本地 typecheck 与 husky 钩子可用）

**Files:** 无（环境准备）

- [ ] **Step 1: 在 worktree 根安装依赖**

Run（在当前 worktree 根）：
```bash
pnpm install --frozen-lockfile
```
Expected: 安装成功，`node_modules/.bin/lint-staged` 存在（后续代码提交的 husky pre-commit 才不报 `lint-staged not found`）。

- [ ] **Step 2: 确认基线 typecheck 通过**

Run:
```bash
pnpm typecheck
```
Expected: PASS（作为基线；本 plan 只改配置/新增文件，不应引入类型错误）。

---

### Task 1: web-main 容器化（standalone + Dockerfile）

这是全 plan 风险最高处（monorepo standalone 依赖追踪）。验证 = 本地 `docker build` + `docker run` + `curl` 首页返回 200。

**Files:**
- Modify: `apps/web-main/next.config.ts`
- Create: `apps/web-main/Dockerfile`

**Interfaces:**
- Produces: 镜像可 `node apps/web-main/server.js` 启动，监听 `0.0.0.0:3000`，首页 200；供 Task 2 compose 与 Task 3 build 引用（镜像名 `web-main`）。

- [ ] **Step 1: 先跑验证命令确认当前失败（无 Dockerfile）**

Run（repo root）：
```bash
docker build -f apps/web-main/Dockerfile -t meshbot/web-main:local .
```
Expected: FAIL —— `failed to read dockerfile` / 文件不存在。

- [ ] **Step 2: 改 `apps/web-main/next.config.ts` 开 standalone**

写入完整内容：
```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  transpilePackages: ["@meshbot/design", "@meshbot/web-common"],
  // 生产容器化：standalone 自带最小 node_modules + server.js。
  output: "standalone",
  // monorepo：trace 根设到仓库根,standalone 才会带上 workspace 依赖（design/web-common/types...）。
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  // dev 期前端在独立 Next dev server（:3002），需显式指向 server-main（默认 :3200）；
  // 生产走同源反代 → 不注入,baseURL 保持空串（相对路径）。
  env: isDev
    ? {
        NEXT_PUBLIC_SERVER_MAIN_URL:
          process.env.NEXT_PUBLIC_SERVER_MAIN_URL ?? "http://localhost:3200",
      }
    : {},
};

export default nextConfig;
```

> 若 `docker build` 阶段报 `import.meta` 不可用（Next 把 config 当 CJS 载入），改用不依赖 ESM 的写法：删掉 `fileURLToPath`/`__dirname` 两行，把 `outputFileTracingRoot` 改为 `path.join(process.cwd(), "..", "..")`（Dockerfile 里 `pnpm --filter @meshbot/web-main build` 的 cwd = `apps/web-main`，`../..` 即仓库根）。

- [ ] **Step 3: 新建 `apps/web-main/Dockerfile`**

写入完整内容：
```dockerfile
# web-main 多阶段 Dockerfile —— 云端轨部署。
# 构建（repo root）：docker build -f apps/web-main/Dockerfile -t meshbot/web-main:local .
# 起动（同源部署无需注入任何 env）：docker run --rm -p 3000:3000 meshbot/web-main:local

# ============ Stage 1: deps ===============================================
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo
# lockfile + workspace 元数据 + 各 package.json,最大化 layer 缓存。
# .pnpmfile.cjs 必须一并 copy（lockfile 记录其 checksum）。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .pnpmfile.cjs ./
COPY apps/web-main/package.json       ./apps/web-main/
COPY packages/web-common/package.json ./packages/web-common/
COPY packages/design/package.json     ./packages/design/
COPY libs/types/package.json          ./libs/types/
COPY libs/types-main/package.json     ./libs/types-main/
COPY libs/types-agent/package.json    ./libs/types-agent/
RUN pnpm install --frozen-lockfile --ignore-scripts

# ============ Stage 2: build ==============================================
FROM deps AS build
COPY tsconfig.base.json ./
COPY libs/types          ./libs/types
COPY libs/types-main     ./libs/types-main
COPY libs/types-agent    ./libs/types-agent
COPY packages/design     ./packages/design
COPY packages/web-common ./packages/web-common
COPY apps/web-main       ./apps/web-main
# 产出 dist 的 workspace 依赖先 build；design 是源码消费（Next transpilePackages）不 build。
RUN pnpm --filter @meshbot/types build \
 && pnpm --filter @meshbot/types-main build \
 && pnpm --filter @meshbot/types-agent build \
 && pnpm --filter @meshbot/web-common build
# 生产 build：不设 NEXT_PUBLIC_SERVER_MAIN_URL → 客户端相对路径（同源）。
# post-build.mjs 会把 .next/static 拷进 .next/standalone/apps/web-main/.next/static。
RUN pnpm --filter @meshbot/web-main build

# ============ Stage 3: runtime ============================================
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# standalone 含 trace 出的 node_modules + apps/web-main/server.js + (post-build 拷入的) static。
COPY --from=build /repo/apps/web-main/.next/standalone ./
# standalone 不含 public,单独拷。
COPY --from=build /repo/apps/web-main/public ./apps/web-main/public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ >/dev/null 2>&1 || exit 1
CMD ["node", "apps/web-main/server.js"]
```

- [ ] **Step 4: build 镜像**

Run（repo root）：
```bash
docker build -f apps/web-main/Dockerfile -t meshbot/web-main:local .
```
Expected: PASS —— 三阶段全过，末尾 `naming to ... meshbot/web-main:local`。
（若 build 步骤报 workspace 包缺失 → 按实际依赖图补 deps 阶段的 `COPY .../package.json`；若报 `output: standalone` 相关路径错 → 见 Step 2 的 CJS 兜底写法。）

- [ ] **Step 5: run + curl 验证容器可服务**

Run:
```bash
docker run -d --name webmain-smoke -p 3000:3000 meshbot/web-main:local
sleep 3
curl -sSi http://localhost:3000/ | head -1
docker rm -f webmain-smoke
```
Expected: 首行 `HTTP/1.1 200 OK`（或 200/307 到默认 locale/登录页均可，关键是**非** 500/连接拒绝）。若连接拒绝 → 检查 `HOSTNAME=0.0.0.0` 是否生效、`server.js` 路径是否为 `apps/web-main/server.js`。

- [ ] **Step 6: 提交**

```bash
git add apps/web-main/next.config.ts apps/web-main/Dockerfile
git commit -m "feat(web-main): 容器化 —— Next standalone + 多阶段 Dockerfile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 重写 prod docker-compose（复用共享服务 + registry 镜像）

**Files:**
- Modify: `infra/prod/docker-compose.prod.yml`
- Modify: `infra/prod/.env.prod.example`

**Interfaces:**
- Consumes: Task 1 的 `web-main` 镜像、既有 `apps/server-main/Dockerfile` 产出的 `server-main` 镜像。
- Produces: 变量契约 `REGISTRY_IMAGE` / `IMAGE_TAG` / `NACOS_*` / `MESHBOT_NODE_ID`，供 Task 3 deploy 渲染 `.env.prod`。

- [ ] **Step 1: 先跑验证确认当前 compose 与新契约不符**

Run（repo root）：
```bash
docker compose -f infra/prod/docker-compose.prod.yml config >/dev/null && echo OK
```
Expected: 现版本因引用未定义变量或仍含 build/postgres 而与目标不符（记录当前输出，作对照）。

- [ ] **Step 2: 重写 `infra/prod/docker-compose.prod.yml`**

写入完整内容：
```yaml
# meshbot 云端轨生产编排 —— server-main + web-main,复用 infra 共享服务。
#
# 前置：infra 的 pgvector/redis/nacos/minio 已在外部网络 `meta1` 常驻;
#       Nacos 里已配 meshbot-server-main.yaml;meshbot_main 库已建 + 迁移已跑（见 DEPLOY.md）。
#
# 用法（deploy job 或手动,repo root）：
#   docker compose -f infra/prod/docker-compose.prod.yml --env-file infra/prod/.env.prod pull
#   docker compose -f infra/prod/docker-compose.prod.yml --env-file infra/prod/.env.prod up -d

services:
  server-main:
    image: ${REGISTRY_IMAGE}/server-main:${IMAGE_TAG}
    container_name: meshbot-server-main
    restart: unless-stopped
    networks:
      - meta1
    environment:
      NODE_ENV: production
      NACOS_SERVER_ADDR: ${NACOS_SERVER_ADDR}
      NACOS_NAMESPACE: ${NACOS_NAMESPACE}
      NACOS_USERNAME: ${NACOS_USERNAME}
      NACOS_PASSWORD: ${NACOS_PASSWORD}
      NACOS_DATA_ID: ${NACOS_DATA_ID:-meshbot-server-main.yaml}
      MESHBOT_NODE_ID: ${MESHBOT_NODE_ID:-0}
    # 不暴露宿主端口：nginx 在 meta1 内按容器名反代（meshbot-server-main:3200）。

  web-main:
    image: ${REGISTRY_IMAGE}/web-main:${IMAGE_TAG}
    container_name: meshbot-web-main
    restart: unless-stopped
    networks:
      - meta1
    # 不暴露宿主端口：nginx 反代 meshbot-web-main:3000。

networks:
  meta1:
    external: true
```

- [ ] **Step 3: 重写 `infra/prod/.env.prod.example`**

写入完整内容：
```bash
# meshbot 云端轨部署变量样例。
# deploy job 会从 GitLab CI/CD 变量自动渲染 infra/prod/.env.prod;手动部署时 cp 本文件为 .env.prod 填值。
# 真实 secret（DB/JWT/加密key/邮件/MinIO）不在这里,全在 Nacos 的 meshbot-server-main.yaml。
#
# .env.prod 已被仓库根 .gitignore（.env.*）覆盖,勿提交。

# ---- 镜像仓库 ----
# = GitLab 内置 $CI_REGISTRY_IMAGE,形如 hub.meta1.top/<group>/<project>
REGISTRY_IMAGE=hub.meta1.top/<group>/meshbot
IMAGE_TAG=latest

# ---- Nacos 引导 ----
NACOS_SERVER_ADDR=nacos:8848
NACOS_NAMESPACE=meshbot
NACOS_DATA_ID=meshbot-server-main.yaml
NACOS_USERNAME=nacos
NACOS_PASSWORD=<change-me>

# ---- Snowflake 节点 ID（多副本部署必唯一,单副本 0 即可）----
MESHBOT_NODE_ID=0
```

- [ ] **Step 4: 用样例变量验证 compose 语法与插值**

Run（repo root）：
```bash
docker compose -f infra/prod/docker-compose.prod.yml \
  --env-file infra/prod/.env.prod.example config
```
Expected: PASS —— 输出解析后的 YAML，`server-main` image = `hub.meta1.top/<group>/meshbot/server-main:latest`，`web-main` 同理，`networks.meta1.external: true`，无 `WARN` 未定义变量。

- [ ] **Step 5: 提交**

```bash
git add infra/prod/docker-compose.prod.yml infra/prod/.env.prod.example
git commit -m "feat(deploy): 重写 prod compose —— 复用 meta1 共享服务 + registry 镜像 + Nacos 引导

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `.gitlab-ci.yml` 流水线

**Files:**
- Create: `.gitlab-ci.yml`

**Interfaces:**
- Consumes: `apps/{server,web}-main/Dockerfile`（Task 1 + 既有）；`infra/prod/docker-compose.prod.yml` 的变量契约（Task 2）。
- Produces: push `main` → verify → build（推 `$CI_REGISTRY_IMAGE/{server,web}-main:{$SHA,latest}`）→ deploy（同机 compose up）。

- [ ] **Step 1: 先跑验证确认文件缺失**

Run（repo root）：
```bash
test -f .gitlab-ci.yml && echo EXISTS || echo MISSING
```
Expected: `MISSING`。

- [ ] **Step 2: 新建 `.gitlab-ci.yml`**

写入完整内容：
```yaml
# meshbot 云端轨 CI/CD —— shell executor,单宿主机。
# push main → verify(typecheck + 静态围栏) → build(两镜像并行,push hub.meta1.top) → deploy(同机 compose up)。
# 真实 secret 全在 Nacos;本流水线只经手 Nacos 引导变量 + 镜像 tag。

stages:
  - verify
  - build
  - deploy

variables:
  IMAGE_TAG: "$CI_COMMIT_SHORT_SHA"
  REGISTRY_IMAGE: "$CI_REGISTRY_IMAGE"

# 仅 main 触发（部署型流水线）
workflow:
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'

# 轻量质量门：typecheck + 静态围栏。全量单测/e2e 由 GitHub CI 把关,此处不重复。
verify:
  stage: verify
  script:
    - >
      docker run --rm
      -v "$CI_PROJECT_DIR":/repo -w /repo
      -v meshbot-pnpm-store:/root/.local/share/pnpm
      node:22-alpine sh -c
      "corepack enable && pnpm install --frozen-lockfile && pnpm typecheck && pnpm check"

build-server-main:
  stage: build
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
    - docker build -f apps/server-main/Dockerfile -t "$REGISTRY_IMAGE/server-main:$IMAGE_TAG" -t "$REGISTRY_IMAGE/server-main:latest" .
    - docker push "$REGISTRY_IMAGE/server-main:$IMAGE_TAG"
    - docker push "$REGISTRY_IMAGE/server-main:latest"

build-web-main:
  stage: build
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
    - docker build -f apps/web-main/Dockerfile -t "$REGISTRY_IMAGE/web-main:$IMAGE_TAG" -t "$REGISTRY_IMAGE/web-main:latest" .
    - docker push "$REGISTRY_IMAGE/web-main:$IMAGE_TAG"
    - docker push "$REGISTRY_IMAGE/web-main:latest"

deploy:
  stage: deploy
  resource_group: production   # 防并发部署
  environment:
    name: production
    url: https://bot.meta1.top
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
    # 从 GitLab CI/CD 变量渲染 compose 的 .env.prod（NACOS_* / MESHBOT_NODE_ID 在项目变量里配好）
    - |
      cat > infra/prod/.env.prod <<EOF
      REGISTRY_IMAGE=$REGISTRY_IMAGE
      IMAGE_TAG=$IMAGE_TAG
      NACOS_SERVER_ADDR=$NACOS_SERVER_ADDR
      NACOS_NAMESPACE=$NACOS_NAMESPACE
      NACOS_DATA_ID=${NACOS_DATA_ID:-meshbot-server-main.yaml}
      NACOS_USERNAME=$NACOS_USERNAME
      NACOS_PASSWORD=$NACOS_PASSWORD
      MESHBOT_NODE_ID=${MESHBOT_NODE_ID:-0}
      EOF
    - docker compose -f infra/prod/docker-compose.prod.yml --env-file infra/prod/.env.prod pull
    - docker compose -f infra/prod/docker-compose.prod.yml --env-file infra/prod/.env.prod up -d
    - docker image prune -f
```

- [ ] **Step 3: 本地校验 YAML 语法**

Run（repo root）：
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.gitlab-ci.yml')); print('YAML OK')"
```
Expected: `YAML OK`。
（GitLab 侧语义 lint 在 Task 6 仓库建好后用 `glab ci lint` 或 项目 CI Lint 页做；此处只保证语法。）

- [ ] **Step 4: 提交**

```bash
git add .gitlab-ci.yml
git commit -m "feat(ci): 新增 GitLab 流水线 —— verify/build/deploy 同机自动部署

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: nginx 三域名反代（**infra 仓库**）

**工作目录切到 infra 仓库**：`/Users/grant/Meta1/infra`（独立 git；不在 meshbot worktree 内）。

**Files:**
- Create: `nginx/conf.d/bot.meta1.top.conf`
- Create: `nginx/conf.d/api-bot.meta1.top.conf`
- Create: `nginx/conf.d/assets.meta1.top.conf`

**Interfaces:**
- Consumes: 容器名 `meshbot-server-main:3200` / `meshbot-web-main:3000`（Task 2）；`minio:9000`（infra 既有）。
- Produces: 三域名对外入口。

- [ ] **Step 1: 新建 `nginx/conf.d/bot.meta1.top.conf`**

写入完整内容：
```nginx
server {
    listen 80;
    server_name bot.meta1.top;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name bot.meta1.top;

    ssl_certificate     /etc/letsencrypt/live/meta1.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/meta1.top/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    client_max_body_size 50m;
    # docker 内嵌 DNS,运行期解析容器名 → 容器重启换 IP 也不 502
    resolver 127.0.0.11 valid=10s;

    location /api/ {
        set $up http://meshbot-server-main:3200;
        proxy_pass $up;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_read_timeout 300s;
    }

    location /socket.io/ {
        set $up http://meshbot-server-main:3200;
        proxy_pass $up;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 900s;
    }

    location / {
        set $up http://meshbot-web-main:3000;
        proxy_pass $up;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
    }
}
```

- [ ] **Step 2: 新建 `nginx/conf.d/api-bot.meta1.top.conf`**

写入完整内容：
```nginx
server {
    listen 80;
    server_name api-bot.meta1.top;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name api-bot.meta1.top;

    ssl_certificate     /etc/letsencrypt/live/meta1.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/meta1.top/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    client_max_body_size 50m;
    resolver 127.0.0.11 valid=10s;

    # 桌面端/CLI/本地轨直连 server-main（API + WS 全量）
    location / {
        set $up http://meshbot-server-main:3200;
        proxy_pass $up;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 900s;
    }
}
```

- [ ] **Step 3: 新建 `nginx/conf.d/assets.meta1.top.conf`**

写入完整内容：
```nginx
server {
    listen 80;
    server_name assets.meta1.top;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name assets.meta1.top;

    ssl_certificate     /etc/letsencrypt/live/meta1.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/meta1.top/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    client_max_body_size 0;      # 大文件/技能包上传下载不限体积
    resolver 127.0.0.11 valid=10s;

    # MinIO S3 出口：presigned 上传/下载
    location / {
        set $up http://minio:9000;
        proxy_pass $up;
        # Host 透传：SigV4 presigned 签名按此 Host 校验,须与 Nacos 里 assets.minio.endPoint 一致
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_connect_timeout 300s;
        proxy_read_timeout 300s;
    }
}
```

- [ ] **Step 4: 宿主机 nginx 配置测试（在部署宿主机上执行）**

Run（宿主机，infra 目录，nginx 容器已在跑）：
```bash
docker compose -f nginx/docker-compose.yml exec nginx nginx -t
```
Expected: `syntax is ok` + `test is successful`。
（若报证书路径不存在 → 确认宿主 `/etc/letsencrypt/live/meta1.top/` 有泛域名证书；若报 `host not found in upstream` → 用了 `resolver` + 变量式 `proxy_pass` 时 nginx **不会**在启动时解析上游,`nginx -t` 应通过；真解析在请求时，Task 6 起容器后验证。）

- [ ] **Step 5: reload 并提交（infra 仓库）**

Run（宿主机）：
```bash
docker compose -f nginx/docker-compose.yml exec nginx nginx -s reload
```
然后（infra 仓库）：
```bash
git add nginx/conf.d/bot.meta1.top.conf nginx/conf.d/api-bot.meta1.top.conf nginx/conf.d/assets.meta1.top.conf
git commit -m "feat(nginx): meshbot 云端轨三域名反代 bot / api-bot / assets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 一次性手动准备 runbook（DEPLOY.md + 执行）

产出可复核的 runbook，并在宿主机执行其中的准备步骤。每步都带校验命令。

**Files:**
- Create: `infra/prod/DEPLOY.md`（meshbot 仓库）

- [ ] **Step 1: 新建 `infra/prod/DEPLOY.md`**

写入完整内容：
````markdown
# meshbot 云端轨部署 Runbook（一次性准备）

前置：infra 的 `pgvector` / `redis` / `nacos` / `minio` 已在外部网络 `meta1` 常驻。
以下命令在**部署宿主机**执行（meshbot 与 infra 两仓库均已 clone 到宿主机）。

## 1. 数据库（pgvector 上建库 + 手动跑迁移）

```bash
# 建库
docker exec -i pgvector psql -U postgres -c "CREATE DATABASE meshbot_main;"
# 按文件名顺序跑迁移（DDL 由 DBA 手动执行,服务不自动建表）
cd <meshbot 仓库根>
for f in $(ls apps/server-main/migrations/*.sql | sort); do
  echo ">> $f"
  docker exec -i pgvector psql -U postgres -d meshbot_main < "$f"
done
# 校验：应列出 meshbot 的表
docker exec -i pgvector psql -U postgres -d meshbot_main -c "\dt"
```

## 2. MinIO（建 bucket）

```bash
docker run --rm --network meta1 minio/mc sh -c "\
  mc alias set m http://minio:9000 minioadmin changeme123456 && \
  mc mb --ignore-existing m/meshbot-skills && \
  mc ls m"
# 建议：为 meshbot 单独建 service account（勿用 root）,记下 accessKey/secretKey 填进 Nacos：
# docker run --rm --network meta1 minio/mc sh -c "mc alias set m http://minio:9000 minioadmin changeme123456 && mc admin user svcacct add m minioadmin"
```

## 3. Nacos（namespace meshbot + dataId meshbot-server-main.yaml）

在 Nacos 控制台（`https://<nacos 对外地址>/nacos`，或宿主 `http://<host>:8848/nacos`）：
1. 命名空间 → 新建 `meshbot`（记下生成的 namespace id）。
2. 配置列表 → 新建：dataId `meshbot-server-main.yaml`，group `DEFAULT_GROUP`，格式 `YAML`，内容（按实际填 secret）：

```yaml
port: 3200
database:
  type: postgres
  host: pgvector
  port: 5432
  username: postgres
  password: <pgvector 口令>
  database: meshbot_main
  synchronize: false
  autoLoadEntities: true
  logging: [error, warn, migration]
jwt:
  secret: <openssl rand -base64 48>
  expires: 7d
redis:
  host: redis
  port: 6379
  db: 0
  password: changeme-redis
security:
  encryption-key: <≥32 字符随机串>
assets:
  minio:
    endPoint: assets.meta1.top
    port: 443
    useSSL: true
    accessKey: <minio accessKey>
    secretKey: <minio secretKey>
    bucket: meshbot-skills
webMainBase: https://bot.meta1.top
# 可选：邮件（阿里云 DirectMail）。省略则邀请码只打服务日志。
# email:
#   endpoint: dm.aliyuncs.com
#   account-name: noreply@mail.meta1.top
#   access-key-id: <ak>
#   access-key-secret: <sk>
#   from: meshbot
```

> `MESHBOT_NODE_ID` 不在 Nacos，由容器 env 提供（compose）。配了 `redis` 必须给它，否则 server-main 拒绝启动。

## 4. GitLab 仓库 + CI/CD 变量

```bash
# 在 git.meta1.top 建 meshbot 项目后,本地加 remote 并推 main
cd <meshbot 仓库根>
git remote add gitlab https://git.meta1.top/<group>/meshbot.git
git push gitlab <当前分支>:main   # 首次；之后正常 push main 触发流水线
```

项目 Settings → CI/CD → Variables 添加（敏感项勾 Masked）：

| Key | Value | Masked |
|-----|-------|--------|
| `NACOS_SERVER_ADDR` | `nacos:8848` | |
| `NACOS_NAMESPACE` | `<meshbot namespace id>` | |
| `NACOS_DATA_ID` | `meshbot-server-main.yaml` | |
| `NACOS_USERNAME` | `<nacos 用户>` | |
| `NACOS_PASSWORD` | `<nacos 口令>` | ✓ |
| `MESHBOT_NODE_ID` | `0` | |

（`REGISTRY_IMAGE` / `IMAGE_TAG` 由 `.gitlab-ci.yml` 从内置变量推导，无需手配。确保项目已启用 Container Registry。）

## 5. DNS

`bot` / `api-bot` / `assets`.meta1.top 均解析到宿主机 IP（泛域名证书 `*.meta1.top` 已覆盖）。

```bash
for h in bot api-bot assets; do echo -n "$h.meta1.top -> "; dig +short $h.meta1.top; done
```

## 6. 首次部署

推 main 触发流水线（Task 6），或宿主机手动：
```bash
cd <meshbot 仓库根>
cp infra/prod/.env.prod.example infra/prod/.env.prod   # 填 REGISTRY_IMAGE/NACOS_*
docker compose -f infra/prod/docker-compose.prod.yml --env-file infra/prod/.env.prod up -d
```
````

- [ ] **Step 2: 提交 runbook**

```bash
cd <meshbot worktree 根>
git add infra/prod/DEPLOY.md
git commit -m "docs(deploy): 云端轨一次性准备 runbook（DB/MinIO/Nacos/GitLab/DNS）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: 按 runbook 在宿主机执行准备（§1–§5）并逐条校验**

Expected：
- `\dt` 列出 meshbot 表；`mc ls m` 含 `meshbot-skills`；Nacos 控制台可见 `meshbot-server-main.yaml`；GitLab 变量齐全；三域名 `dig` 解析到宿主 IP。

---

### Task 6: 首次部署 + 端到端验收

**Files:** 无（集成验证）

- [ ] **Step 1: 合并/推送到 GitLab main 触发流水线**

把本 plan 的 meshbot 改动（Task 1–3、5）合入 main 并 `git push gitlab ...:main`（infra 改动 Task 4 已在宿主机 pull 生效）。
Expected: GitLab pipeline `verify → build → deploy` 全绿；registry 出现 `server-main:$SHA`、`web-main:$SHA`。
（若无仓库前无法 lint，可先在项目 CI Lint 页或 `glab ci lint` 校验 `.gitlab-ci.yml` 语义。）

- [ ] **Step 2: 容器与健康检查**

Run（宿主机）：
```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep meshbot
curl -sSf https://api-bot.meta1.top/api/health
```
Expected: `meshbot-server-main` / `meshbot-web-main` 均 `Up (healthy)`；health 返回 `{"status":"ok",...}`（db + redis up）。
（若 health 502：看 `docker logs meshbot-server-main` —— dev-secret fail-fast？Nacos 拉取失败？DB/redis 连不上？）

- [ ] **Step 3: web-main 页面 + 同源 API + WS**

Run:
```bash
curl -sSI https://bot.meta1.top/ | head -1
curl -sSf https://bot.meta1.top/api/health
```
Expected: 首页 `200`（或到登录页的 200/307）；`/api/health` 同源可达 200。浏览器打开 `https://bot.meta1.top` 完成注册/登录，DevTools Network 里 `/socket.io/` WS 连接 `101 Switching Protocols`。

- [ ] **Step 4: presigned 出口验收**

在 web 端建一个分享链接并访问下载，或直接核对：`public-share` 返回的下载 URL host = `https://assets.meta1.top/...`，浏览器可直接下载（非 403 签名错、非连接拒绝）。
Expected: 下载成功；若 403 → 核对 Nacos `assets.minio.endPoint=assets.meta1.top`/`useSSL:true`/`port:443` 与 nginx `proxy_set_header Host $host` 一致。

- [ ] **Step 5: 记录部署结果**

在 PR / commit / 对话中记录：pipeline 链接、镜像 tag、验收 5 项结果。无独立提交。

---

## 自检（对照 spec）

- **spec §4.1 web-main 容器化** → Task 1 ✅
- **spec §4.2 compose 重写** → Task 2 ✅
- **spec §4.3 .gitlab-ci.yml** → Task 3 ✅
- **spec §4.4 nginx 三域名** → Task 4 ✅
- **spec §4.5 Nacos 配置 + secret 流** → Task 5 §3 ✅
- **spec §5 手动准备（DB/MinIO/Nacos/CI 变量/DNS/GitLab remote）** → Task 5 ✅
- **spec §8 验收标准 5 项** → Task 6 Step 2–4 ✅
- **spec §6 运维（健康检查/回滚/DNS resolver/并发）** → Task 3（resource_group）+ Task 4（resolver）+ Task 6 ✅

类型/命名一致性：容器名 `meshbot-server-main:3200` / `meshbot-web-main:3000`、变量 `REGISTRY_IMAGE`/`IMAGE_TAG`/`NACOS_*`/`MESHBOT_NODE_ID`、镜像路径 `$REGISTRY_IMAGE/{server,web}-main:$IMAGE_TAG` 在 Task 2/3/4 间一致。
