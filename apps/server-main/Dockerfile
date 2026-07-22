# server-main 多阶段 Dockerfile —— Phase 4 Track C1。
#
# 关键技巧：runtime 用 `pnpm deploy --filter @meshbot/server-main` 把 server-main
# 单包的 prod deps（含 workspace 依赖）拷成独立 node_modules，避免拉入 server-agent
# 的 better-sqlite3 / cli 的 swc / 根 dev 依赖 typescript 等。
#
# 构建（在 repo root）：
#   docker build -f apps/server-main/Dockerfile -t meshbot/server-main:local .
# 起动（配置走 loadAppConfig：Nacos 引导 env 或镜像内置/挂载的 conf/application.yml）：
#   # 方式一：Nacos 引导（生产推荐；漏配会落回镜像内置 YAML 并因 dev secret fail-fast）
#   docker run --rm -p 3200:3200 \
#     -e NACOS_SERVER_ADDR=nacos.example.com:8848 \
#     -e NACOS_DATA_ID=server-main.yml \
#     -e MESHBOT_NODE_ID=0 \
#     meshbot/server-main:local
#   # 方式二：挂载本地 YAML 覆盖（conf/application.local.yml 深合并覆盖内置默认值）
#   docker run --rm -p 3200:3200 \
#     -v $PWD/application.local.yml:/app/conf/application.local.yml:ro \
#     meshbot/server-main:local

# ============ Stage 1: deps ===============================================
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /repo

# 只 copy lockfile + workspace 元数据 + 各 package.json，最大化 layer 缓存。
# .pnpmfile.cjs 必须一并 copy：lockfile 记录其 pnpmfileChecksum，缺它会导致
# frozen install 报 ERR_PNPM_LOCKFILE_CONFIG_MISMATCH。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .pnpmfile.cjs ./
COPY apps/server-main/package.json ./apps/server-main/
COPY libs/common/package.json      ./libs/common/
COPY libs/main/package.json        ./libs/main/
COPY libs/types/package.json       ./libs/types/
COPY libs/types-main/package.json  ./libs/types-main/
COPY libs/assets/package.json      ./libs/assets/

# ⚠️ 禁止把 registry 换成第三方镜像源（含 registry.npmmirror.com）。
# 2026-07-23 生产事故：换镜像源后 --frozen-lockfile 失去锁定效力，装出了
# lockfile 里根本不存在的版本——顶层 zod 4.4.3、@meshbot/types 嵌套 zod 3.0.0
# （lockfile 锁的是 3.25.76）。3.0.0 没有 z.coerce，server-main 启动即崩、
# 生产 API 502。对照实验：同一 Dockerfile 换回官方源即得到正确的 3.25.76。
#
# 当初换源是为了解决 runner 拉包超时，但真正的病因是 pnpm 默认 60s fetch 超时；
# 下面的超时/重试/并发设置已经解决了它——官方源实测 35.1s 装完 2290 个包。
#
# 注：不加 BuildKit cache mount 缓存 pnpm store——本仓 nodeLinker 是 hoisted，
# 直接摊进 node_modules 不走内容寻址 store，实测 store 恒空、reused 恒为 0。
RUN pnpm config set fetch-timeout 300000 && \
    pnpm config set fetch-retries 5 && \
    pnpm config set network-concurrency 8 && \
    pnpm install --frozen-lockfile --ignore-scripts

# ============ Stage 2: build ===============================================
FROM deps AS build
COPY tsconfig.base.json ./
COPY libs/common      ./libs/common
COPY libs/main        ./libs/main
COPY libs/types       ./libs/types
COPY libs/types-main  ./libs/types-main
COPY libs/assets      ./libs/assets
COPY apps/server-main ./apps/server-main

RUN pnpm --filter @meshbot/types build \
 && pnpm --filter @meshbot/common build \
 && pnpm --filter @meshbot/types-main build \
 && pnpm --filter @meshbot/assets build \
 && pnpm --filter @meshbot/main build \
 && pnpm --filter @meshbot/server-main build

# 用 pnpm deploy 提取 server-main 的 prod 闭包到 /out。
# --legacy 保留 node_modules/.pnpm 软链结构。
# 注意：不能加 --no-optional —— 它会触发 pnpm deploy bug（被排除的 optional 依赖
# @pkgjs/parseargs / class-transformer 仍被引用 → ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY）。
# typeorm 的无关 native 驱动（better-sqlite3 等）已在根 .pnpmfile.cjs 里从其 optional
# peer 声明中剥离，故不加 --no-optional 也不会被拉进本镜像。
RUN pnpm --filter @meshbot/server-main deploy \
      --prod --legacy /out

# 单独 copy dist 与 i18n（deploy 不带源码 build 产物，只带 deps）。
# 配置走 Nacos（NACOS_* env 引导），不再随镜像内置 conf/application.yml，故不拷 conf。
RUN cp -r /repo/apps/server-main/dist /out/dist \
 && cp -r /repo/apps/server-main/i18n /out/i18n \
 && cp -r /repo/libs/common/dist      /out/node_modules/@meshbot/common/dist \
 && cp -r /repo/libs/main/dist        /out/node_modules/@meshbot/main/dist \
 && cp -r /repo/libs/types/dist       /out/node_modules/@meshbot/types/dist \
 && cp -r /repo/libs/types-main/dist  /out/node_modules/@meshbot/types-main/dist \
 && cp -r /repo/libs/assets/dist      /out/node_modules/@meshbot/assets/dist

# ============ Stage 3: runtime ============================================
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3200

# 仅 copy deploy 产物，根 monorepo 不进 runtime
COPY --from=build /out ./

EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3200/api/health || exit 1

CMD ["node", "dist/main.js"]
