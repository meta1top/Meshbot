# Meshbot

[![CI](https://github.com/meta1top/Meshbot/actions/workflows/ci.yml/badge.svg)](https://github.com/meta1top/Meshbot/actions/workflows/ci.yml)

一个开源的 AI Agent 平台，将本地强大的 Agent 执行能力与云端协同管理结合在一起。

**桌面端（Agent）** 负责在本地运行 AI Agent，充分利用本地算力和私有数据，执行复杂的多步骤任务——文件操作、代码生成、工具调用、MCP 集成，一切都在你的机器上完成，数据不离开本地。

**云端（Main）** 提供统一的协同控制平面。当你拥有多台设备、多个 Agent 实例时，云端让你在一个面板上管理所有 Agent 的状态、任务和配置。团队协作、远程监控、跨设备同步，都由云端完成。

> 本地执行，云端协同。

## 项目结构

```
apps/
├── cli-agent/        命令行 Agent 工具
├── desktop/          Electron 桌面壳
├── server-agent/     NestJS 本地 agent 后端（:3100，SQLite）
├── server-main/      NestJS 云平台后端（:3200，Postgres）
├── web-agent/        Next.js 桌面端 UI（:3001）
└── web-main/         Next.js 云平台前端（:3002）

libs/
├── agent/            LangGraph 编排 + Agent 域业务
├── common/           NestJS 基础设施（装饰器 / TxTypeOrmModule / Lock / Cache / DTO）
├── main/             server-main 业务模块（注册 / 登录框架基线，业务由 meshbot 自行迭代）
├── types/            跨域 Zod schema + TS 类型
├── types-agent/      Agent 域 schema
└── types-main/       云端域 schema

packages/
├── design/           Tailwind + shadcn/Radix 组件库
└── web-common/       Web 公共逻辑（Next.js shared）

infra/
└── dev/              本地开发依赖（docker-compose Postgres）
```

## 技术栈

- **包管理**：pnpm workspace + Turborepo
- **后端**：NestJS 11, TypeORM 0.3, LangGraph
- **前端**：Next.js 15 (App Router), Tailwind CSS v4, shadcn/ui, next-intl
- **桌面端**：Electron 41
- **类型**：TypeScript 5, Zod 3
- **数据**：本地 SQLite (better-sqlite3) + LanceDB；云端 Postgres 16
- **i18n**：nestjs-i18n（后端） + next-intl（前端）
- **测试**：Jest + ts-jest（含真 Postgres 隔离 schema e2e）
- **质量门禁**：Biome（lint/format） + 5 个静态围栏（tx / naming / lock-tx / repo / dead-exports）+ husky pre-commit

## 快速开始

```bash
# 安装依赖（Node >= 22）
pnpm install

# 启动云端依赖（server-main / 测试需要）
pnpm dev:db:up            # docker-compose Postgres

# 启动单个应用
pnpm dev:web-agent        # Next.js 桌面端 UI
pnpm dev:web-main         # Next.js 云平台前端
pnpm dev:server-agent     # NestJS 本地 agent
pnpm dev:server-main      # NestJS 云平台后端（先 pnpm migration:run:main）
pnpm dev:desktop          # Electron（需先启动 web-agent）
pnpm dev:cli-agent        # 命令行 Agent

# 全部同时启动
pnpm dev

# 全量构建
pnpm build
```

## 本地复刻 CI

提 PR 前本地跑一遍这套（与 `.github/workflows/ci.yml` 严格对齐）：

```bash
pnpm install --frozen-lockfile
pnpm dev:db:up                       # e2e 依赖 Postgres
pnpm lint                            # Biome
pnpm typecheck                       # 全包 TS 类型检查
pnpm check:strict                    # 5 围栏（CI 用 strict；本地 pnpm check 走 baseline 增量亦可）
pnpm sync:skills -- --check          # .cursor/rules ↔ .claude/skills 一致性
pnpm sync:locales -- --check         # i18n key 对齐
pnpm test                            # Jest（含 server-main e2e）
pnpm build                           # turbo run build
```

husky pre-commit 已自动跑前 5 项（用 baseline 增量，CI 用 strict）。

## 下载与安装

- **桌面端（desktop）**：从 [Releases](https://github.com/meta1top/Meshbot/releases) 下载对应平台安装包
  - macOS：`*.dmg`（Apple Silicon / Intel）
  - Windows：`*.exe`
  - Linux：`*.AppImage`
- **CLI（cli-agent）**：

  ```bash
  npm i -g @meshbot/cli-agent
  meshbot --help
  ```

- **server-agent（npm 包）**：通常通过 cli-agent / desktop 间接使用；独立部署见 [`infra/prod/README.md`](infra/prod/README.md) Docker 编排
- **server-main（云协同后端）**：仅 Docker 形态，见 [`infra/prod/README.md`](infra/prod/README.md)

变更日志：[CHANGELOG.md](CHANGELOG.md)。

## 文档

- **架构与规约**：[`.claude/CLAUDE.md`](.claude/CLAUDE.md)
- **设计文档**：[`docs/superpowers/specs/`](docs/superpowers/specs/)
- **实施计划**：[`docs/superpowers/plans/`](docs/superpowers/plans/)
- **贡献指南**：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- **生产部署**：[`infra/prod/README.md`](infra/prod/README.md)

## License

MIT
