# Anybot

一个开源的 AI Agent 平台，将本地强大的 Agent 执行能力与云端协同管理结合在一起。

**桌面端（Agent）** 负责在本地运行 AI Agent，充分利用本地算力和私有数据，执行复杂的多步骤任务——文件操作、代码生成、工具调用、MCP 集成，一切都在你的机器上完成，数据不离开本地。

**云端（Main）** 提供统一的协同控制平面。当你拥有多台设备、多个 Agent 实例时，云端让你在一个面板上管理所有 Agent 的状态、任务和配置。团队协作、远程监控、跨设备同步，都由云端完成。

> 本地执行，云端协同。

## 项目结构

```
apps/
├── desktop/          Electron 桌面壳
├── server-agent/     NestJS 本地 agent 后端（:3100）
├── server-main/      NestJS 云平台后端（:3200）
├── web-agent/        Next.js 桌面端 UI（:3001）
└── web-main/         Next.js 云平台前端（:3002）

libs/
├── types/            前后端共享类型（Zod）
└── shared/           NestJS 共享模块

packages/
├── common/           Web 公共逻辑
└── design/           Tailwind + shadcn 组件库
```

## 技术栈

- **包管理**：pnpm workspace + Turborepo
- **后端**：NestJS, LangGraph
- **前端**：Next.js (App Router), Tailwind CSS v4, shadcn/ui
- **桌面端**：Electron
- **类型**：TypeScript, Zod
- **数据存储**：SQLite (better-sqlite3), LanceDB

## 快速开始

```bash
# 安装依赖
pnpm install

# 全量构建
pnpm build

# 启动单个应用
pnpm dev:web-agent        # Next.js 桌面端 UI
pnpm dev:web-main         # Next.js 云平台前端
pnpm dev:server-agent     # NestJS 本地 agent
pnpm dev:server-main      # NestJS 云平台后端
pnpm dev:desktop          # Electron（需先启动 web-agent）

# 全部同时启动
pnpm dev
```

## License

MIT
