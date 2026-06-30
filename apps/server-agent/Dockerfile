# server-agent 多阶段 Dockerfile —— Phase 4 Track C2。
#
# 与 server-main 不同点：
# - better-sqlite3 是 native module；alpine build stage 需要 python3 + make + g++
# - runtime 装 sqlite-libs（更小，仅运行时所需）
# - SQLite db 文件落 /data（VOLUME），通过 MESHBOT_HOME 注入
# - 健康检查 GET /api/setup-status（server-agent 没有显式 /health，但 setup-status 是免登录的 GET）
#
# 注：server-agent 主要面向桌面端 fork 出的子进程；Docker 化用于
# CI / 远程测试 / 多机调试。生产真实形态仍是 Electron 内嵌的 server。
#
# 构建（在 repo root）：
#   docker build -f apps/server-agent/Dockerfile -t meshbot/server-agent:local .

# ============ Stage 1: deps ===============================================
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++ libc6-compat \
 && corepack enable
WORKDIR /repo

# .pnpmfile.cjs 必须一并 copy：lockfile 记录其 pnpmfileChecksum，缺它会导致
# frozen install 报 ERR_PNPM_LOCKFILE_CONFIG_MISMATCH。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .pnpmfile.cjs ./
COPY apps/server-agent/package.json ./apps/server-agent/
COPY libs/common/package.json       ./libs/common/
COPY libs/agent/package.json        ./libs/agent/
COPY libs/types/package.json        ./libs/types/
COPY libs/types-agent/package.json  ./libs/types-agent/
COPY libs/assets/package.json       ./libs/assets/

RUN pnpm install --frozen-lockfile

# ============ Stage 2: build ===============================================
FROM deps AS build
COPY tsconfig.base.json ./
COPY libs/common       ./libs/common
COPY libs/agent        ./libs/agent
COPY libs/types        ./libs/types
COPY libs/types-agent  ./libs/types-agent
COPY libs/assets       ./libs/assets
COPY apps/server-agent ./apps/server-agent

RUN pnpm --filter @meshbot/types build \
 && pnpm --filter @meshbot/common build \
 && pnpm --filter @meshbot/types-agent build \
 && pnpm --filter @meshbot/assets build \
 && pnpm --filter @meshbot/agent build \
 && pnpm --filter @meshbot/server-agent build

# 用 pnpm deploy 提取 server-agent 单包的 prod 闭包到 /out
RUN pnpm --filter @meshbot/server-agent deploy \
      --prod --legacy --no-optional /out

# build 的 dist 不在 deploy 输出里，单独拷
RUN cp -r /repo/apps/server-agent/dist /out/dist \
 && cp -r /repo/apps/server-agent/i18n /out/i18n \
 && cp -r /repo/libs/common/dist       /out/node_modules/@meshbot/common/dist \
 && cp -r /repo/libs/agent/dist        /out/node_modules/@meshbot/agent/dist \
 && cp -r /repo/libs/types/dist        /out/node_modules/@meshbot/types/dist \
 && cp -r /repo/libs/types-agent/dist  /out/node_modules/@meshbot/types-agent/dist \
 && cp -r /repo/libs/assets/dist       /out/node_modules/@meshbot/assets/dist

# ============ Stage 3: runtime ============================================
FROM node:22-alpine AS runtime
RUN apk add --no-cache sqlite-libs libc6-compat
WORKDIR /app
ENV NODE_ENV=production \
    MESHBOT_PORT=3100 \
    MESHBOT_HOME=/data

COPY --from=build /out ./

# SQLite + LangGraph 日志等持久化到 volume
VOLUME ["/data"]
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3100/api/setup-status || exit 1

CMD ["node", "dist/main.js"]
