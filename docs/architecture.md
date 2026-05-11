# MeshBot 架构图

## 整体架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户交互层                                       │
├────────────────────────────────────┬────────────────────────────────────────┤
│          桌面端 (Electron)          │           云平台 (Browser)              │
│                                    │                                        │
│  ┌──────────────────────────────┐  │  ┌──────────────────────────────────┐  │
│  │       @meshbot/desktop        │  │  │        @meshbot/web-main          │  │
│  │    Electron 主进程 + 壳       │  │  │     Next.js 云平台前端 (SSR)      │  │
│  │  · 窗口管理 / 系统托盘        │  │  │  · Agent 统一管理界面              │  │
│  │  · fork() 启动 server-agent  │  │  │  · 浏览器直接访问                  │  │
│  └──────────┬───────────────────┘  │  └──────────────┬───────────────────┘  │
│             │ load URL              │                 │ HTTP/WS              │
│  ┌──────────▼───────────────────┐  │  ┌──────────────▼───────────────────┐  │
│  │      @meshbot/web-agent       │  │  │       @meshbot/server-main        │  │
│  │  Next.js 桌面端 UI (静态导出) │  │  │     NestJS 云平台后端             │  │
│  │  · 对话界面 / 工具管理        │  │  │  · Agent 注册 / 发现              │  │
│  │  · output: 'export' → HTML   │  │  │  · 用户认证                       │  │
│  └──────────┬───────────────────┘  │  │  · 多 Agent 管理                  │  │
│             │ HTTP API              │  └──────────────────────────────────┘  │
│  ┌──────────▼───────────────────┐  │                                        │
│  │    @meshbot/server-agent      │  │                                        │
│  │    NestJS 本地 Agent 后端     │  │                                        │
│  │  · LangGraph 进程管理         │  │                                        │
│  │  · 会话 / 工具 / MCP / 提示词 │  │                                        │
│  │  · SQLite + LanceDB          │  │                                        │
│  └──────────────────────────────┘  │                                        │
└────────────────────────────────────┴────────────────────────────────────────┘
```

## 包间依赖关系

```
                        ┌───────────────────┐
                        │  @meshbot/types    │  ← 全栈最底层依赖
                        │  Zod schema 定义   │
                        └─────────┬─────────┘
                  ┌───────────────┼───────────────┐
                  │               │               │
          ┌───────▼──────┐ ┌─────▼──────┐ ┌──────▼──────┐
          │@meshbot/shared│ │@meshbot/    │ │@meshbot/     │
          │NestJS 共享   │ │common      │ │design       │
          │Guard/拦截器   │ │HTTP/工具    │ │UI 组件库    │
          └───────┬──────┘ └─────┬──────┘ └──────┬──────┘
          ┌───────┴──────┐ ┌─────┴──────────────┬┘
          │              │ │                    │
  ┌───────▼───┐ ┌────────▼─▼──┐        ┌───────▼────┐
  │server-    │ │ web-agent   │        │ web-main   │
  │agent      │ └─────────────┘        └────────────┘
  └───────────┘
  ┌───────────┐
  │server-    │
  │main       │
  └───────────┘
```

## 目录结构

```
meshbot/
├── apps/                          # 可部署应用
│   ├── desktop/                   # Electron 桌面壳
│   ├── server-agent/              # NestJS 本地 Agent (port 3100)
│   ├── server-main/               # NestJS 云平台后端 (port 3200)
│   ├── web-agent/                 # Next.js 桌面端 UI (port 3001)
│   └── web-main/                  # Next.js 云平台前端 (port 3002)
├── libs/                          # 后端共享模块
│   ├── types/                     # 全栈共享类型 (Zod + TS)
│   └── shared/                    # NestJS 共享 (Guard/Interceptor)
├── packages/                      # 前端共享包
│   ├── common/                    # Web 公共逻辑 (HTTP/工具)
│   └── design/                    # UI 组件库 (Tailwind v4 + shadcn)
├── turbo.json                     # Turborepo 构建编排
├── pnpm-workspace.yaml            # pnpm workspace 配置
└── tsconfig.base.json             # 共享 TypeScript 配置
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 包管理 | pnpm workspace |
| 构建编排 | Turborepo |
| 语言 | TypeScript |
| 后端框架 | NestJS 11 |
| 前端框架 | Next.js 15 (App Router) |
| 桌面端 | Electron |
| 样式 | Tailwind CSS v4 + shadcn/ui |
| 类型验证 | Zod |
| 本地存储 | SQLite (better-sqlite3) |
| 向量存储 | LanceDB |
| 代码质量 | Biome (lint + format) |

## 数据流

```
用户 ──→ Electron 窗口
              │
              ├──→ web-agent (UI 渲染)
              │        │
              │        ├── HTTP ──→ server-agent (AI 处理)
              │        │                │
              │        │                ├── LangGraph (Agent 编排)
              │        │                ├── SQLite (会话/配置持久化)
              │        │                └── LanceDB (向量检索)
              │        │
              │        └── WebSocket ──→ server-agent (实时通信)
              │
              └──→ server-main (注册/心跳)
                         │
                         └── 云平台 DB (Agent 注册信息)

浏览器用户 ──→ web-main ──→ server-main ──→ 管理所有已注册 Agent
```

## 构建顺序 (Turborepo 拓扑)

```
第 1 层 (无依赖):    @meshbot/types
                          │
第 2 层 (依赖 types): @meshbot/shared    @meshbot/common    @meshbot/design
                          │                   │                 │
第 3 层 (应用层):    server-agent       web-agent          web-main
                     server-main            └─────────────────┘
                          │
第 4 层 (壳):        desktop (fork server-agent, load web-agent)
```
