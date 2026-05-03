# Anybot Monorepo 初始化设计

## 概述

初始化 Anybot 单体仓库（monorepo），包含 5 个可部署应用、2 个后端共享库、2 个前端共享包。使用 pnpm workspace + Turborepo 管理依赖和构建。

## 目录结构

```
anybot/
├── apps/
│   ├── desktop/            # @anybot/desktop — Electron 主进程
│   ├── server-agent/       # @anybot/server-agent — NestJS 本地 agent
│   ├── web-agent/          # @anybot/web-agent — Next.js 桌面端 UI
│   ├── server-main/        # @anybot/server-main — NestJS 云平台后端
│   └── web-main/           # @anybot/web-main — Next.js 云平台前端
├── libs/
│   ├── types/              # @anybot/types — 前后端共享类型
│   └── shared/             # @anybot/shared — NestJS 共享模块
├── packages/
│   ├── common/             # @anybot/common — Web 公共逻辑
│   └── design/             # @anybot/design — 统一组件库
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

### 目录职责划分

| 目录 | 定位 | 消费者 |
|------|------|--------|
| `apps/` | 可部署/可运行的应用 | 终端用户 |
| `libs/` | 后端共享模块（`types` 例外，全栈共享） | `server-agent`、`server-main`（`types` 被所有包依赖） |
| `packages/` | 前端共享包 | `web-agent`、`web-main` |

## 工具链

- **包管理器**：pnpm（workspace 协议 `workspace:*` 管理包间引用）
- **构建编排**：Turborepo（`turbo.json` 定义 pipeline，支持增量构建和缓存）
- **TypeScript**：根级 `tsconfig.base.json` 统一编译配置，各子包 `extends` 它
- **代码质量**：ESLint + Prettier（根级配置，子包可覆盖）

### pnpm-workspace.yaml

```yaml
packages:
  - 'apps/*'
  - 'libs/*'
  - 'packages/*'
```

### turbo.json pipeline

- `build`：依赖拓扑构建（`dependsOn: ["^build"]`），输出 `dist/**`、`.next/**`
- `dev`：并行启动所有 dev server（`persistent: true`）
- `lint`：独立运行，无依赖
- `typecheck`：依赖拓扑（`dependsOn: ["^build"]`）

### 包间依赖关系

```
web-agent ──┐
            ├──→ @anybot/common ──→ @anybot/types
web-main ───┘    @anybot/design

server-agent ──┐
               ├──→ @anybot/shared ──→ @anybot/types
server-main ───┘

desktop ──→ (无直接代码依赖，通过 fork 启动 server-agent)
```

## 应用设计

### apps/desktop — Electron 主进程

- **包名**：`@anybot/desktop`
- **技术**：Electron + electron-builder
- **职责**：窗口管理、系统托盘、`child_process.fork()` 启动 server-agent、IPC 通信
- **安全**：禁用 `nodeIntegration`，启用 `contextIsolation`，通过 `preload.ts` + `contextBridge` 暴露有限 API
- **骨架文件**：`main.ts`、`preload.ts`、`electron-builder.yml`、`package.json`、`tsconfig.json`

### apps/server-agent — NestJS 本地 agent

- **包名**：`@anybot/server-agent`
- **技术**：NestJS standalone 项目（不使用 NestJS 内置 monorepo 模式）
- **职责**：管理 LangGraph agent 进程、会话、工具、MCP、提示词
- **数据存储**：本地 SQLite（better-sqlite3）、LanceDB（向量检索）
- **依赖**：`@anybot/shared`、`@anybot/types`
- **骨架文件**：`src/main.ts`、`src/app.module.ts`、`nest-cli.json`、`package.json`、`tsconfig.json`

### apps/web-agent — Next.js 桌面端 UI

- **包名**：`@anybot/web-agent`
- **技术**：Next.js App Router
- **运行模式**：开发时 dev server + HMR，生产时通过 `output: 'export'` 生成静态产物给 Electron 加载
- **依赖**：`@anybot/design`、`@anybot/common`、`@anybot/types`
- **骨架文件**：`src/app/layout.tsx`、`src/app/page.tsx`、`next.config.ts`、`tailwind.config.ts`、`package.json`、`tsconfig.json`

### apps/server-main — NestJS 云平台后端

- **包名**：`@anybot/server-main`
- **技术**：NestJS standalone 项目
- **职责**：agent 注册/发现、用户认证、多 agent 统一管理
- **依赖**：`@anybot/shared`、`@anybot/types`
- **骨架文件**：`src/main.ts`、`src/app.module.ts`、`nest-cli.json`、`package.json`、`tsconfig.json`

### apps/web-main — Next.js 云平台前端

- **包名**：`@anybot/web-main`
- **技术**：Next.js App Router，标准 SSR/CSR 模式（浏览器访问）
- **依赖**：`@anybot/design`、`@anybot/common`、`@anybot/types`
- **骨架文件**：与 `web-agent` 相同结构

## 共享包设计

### libs/types — @anybot/types

- **定位**：全栈共享的类型定义，所有包的最底层依赖
- **技术**：纯 TypeScript + Zod，无运行时框架依赖
- **内容**：Zod schema 定义 + `z.infer` 推导 TypeScript 类型
- **编译**：`tsc` 输出到 `dist/`，`package.json` 的 `main` 和 `types` 指向编译产物
- **骨架文件**：`src/index.ts`、`package.json`、`tsconfig.json`

### libs/shared — @anybot/shared

- **定位**：两个 NestJS 应用共享的后端逻辑
- **技术**：TypeScript + NestJS 装饰器
- **peerDependencies**：`@nestjs/common`、`@nestjs/core`
- **内容**：通用 Guard、Interceptor、NestJS Module、工具服务、错误处理基类
- **依赖**：`@anybot/types`
- **骨架文件**：`src/index.ts`、`package.json`、`tsconfig.json`

### packages/common — @anybot/common

- **定位**：两个 Next.js 应用共享的前端公共逻辑
- **技术**：纯 TypeScript，无框架绑定
- **内容**：HTTP 请求封装、通用工具函数、常量、前端错误处理
- **依赖**：`@anybot/types`
- **骨架文件**：`src/index.ts`、`package.json`、`tsconfig.json`

### packages/design — @anybot/design

- **定位**：统一 UI 组件库
- **技术**：React + Tailwind CSS v4 + shadcn/ui
- **导出方式**：直接导出 TSX 源码（不预编译），由消费方 Next.js 编译
- **peerDependencies**：`react`、`react-dom`
- **骨架文件**：`src/index.ts`、`src/components/`、`package.json`、`tsconfig.json`、`tailwind.config.ts`

## NestJS 集成策略

不使用 NestJS 内置 monorepo 模式。每个 NestJS 应用作为 pnpm workspace 中的独立 standalone 项目：

- 各自拥有独立的 `nest-cli.json`、`package.json`、`tsconfig.json`
- `libs/shared` 中的 NestJS 模块是带装饰器的普通 TypeScript 类，用 `tsc` 编译
- NestJS 相关依赖通过 `peerDependencies` 声明，由消费方应用提供实际包

## 初始化范围

本次仅初始化仓库骨架：

- 根级配置文件（`package.json`、`pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`、`.gitignore`）
- 9 个子包的目录结构和 `package.json`、`tsconfig.json`
- 各应用的最小入口文件（能 `pnpm install && pnpm build` 通过）
- 不含业务逻辑代码
