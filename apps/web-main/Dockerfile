# web-main 多阶段 Dockerfile —— 云端轨部署。
# 构建（repo root）：docker build -f apps/web-main/Dockerfile -t meshbot/web-main:local .
# 起动（同源部署无需注入任何 env）：docker run --rm -p 3000:3000 meshbot/web-main:local

# ============ Stage 1: deps ===============================================
FROM node:24-alpine AS deps
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
# ⚠️ 禁止换第三方镜像源，理由见 apps/server-main/Dockerfile 同段注释
# （2026-07-23 生产事故：镜像源下 pnpm deploy 的重解析装出了 lockfile 里不存在
# 的 zod 版本，server-main 启动崩溃。本文件当时未受影响——web-main 不走
# pnpm deploy——但同样禁止，避免将来加入重解析步骤时踩同一个坑）。
RUN pnpm config set fetch-timeout 300000 && \
    pnpm config set fetch-retries 5 && \
    pnpm config set network-concurrency 8 && \
    pnpm install --frozen-lockfile --ignore-scripts

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
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# standalone 含 trace 出的 node_modules + apps/web-main/server.js + (post-build 拷入的) static。
COPY --from=build /repo/apps/web-main/.next/standalone ./
# standalone 不含 public,单独拷。
COPY --from=build /repo/apps/web-main/public ./apps/web-main/public
EXPOSE 3000
# 用 127.0.0.1 而非 localhost：alpine 里 localhost 优先解析 IPv6 ::1,而 Next
# 按 HOSTNAME=0.0.0.0 只绑 IPv4 → localhost 探测被拒致 unhealthy。
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1
CMD ["node", "apps/web-main/server.js"]
