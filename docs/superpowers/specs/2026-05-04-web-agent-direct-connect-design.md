# web-agent 直连 server-agent 架构设计

> 日期：2026-05-04

## 背景与驱动力

当前 web-agent（Next.js）通过 Electron IPC → 主进程 → HTTP 三层链路访问 server-agent（NestJS）。存在以下问题：

1. **开发效率低**：每新增一个 API，需要同时编写 preload 暴露、IPC handler、HTTP 封装三层胶水代码
2. **功能扩展受限**：即将接入的 LLM 流式输出（SSE）和文件上传/下载，通过 IPC 中转实现复杂度极高
3. **部署形态扩展**：web-agent 需要支持脱离 Electron，在本机浏览器和局域网远程浏览器中独立访问 server-agent

## 决策：web-agent 直连 server-agent

砍掉 Electron 主进程的 API 代理角色，web-agent 通过 HTTP 直连 server-agent。

### 否决的方案

- **方案 B（双通道）**：Electron 保留 IPC 代理 + 浏览器模式直连。需维护两套通信通道，SSE 在 Electron 模式下仍需 IPC 中转，核心问题未解决。
- **方案 C（Next.js 代理）**：Next.js API Routes 做反向代理。本质上只是换了代理宿主，且 web-agent 需从静态导出改为服务端模式，增加部署复杂度。

## 整体架构

```
┌─────────────────────────────────────┐
│        Electron 主进程 (desktop)     │
│  职责：窗口管理、托盘、通知、快捷键   │
│  启动/管理 server-agent 子进程       │
│  不再代理任何 API 请求               │
└──────────────┬──────────────────────┘
               │ 管理（fork/kill）
               ▼
┌─────────────────────────────────────┐
│     server-agent (NestJS :3100)      │
│  绑定 0.0.0.0:3100                  │
│  + CORS 白名单                      │
│  + JWT 认证                         │
│  API / SSE / 文件上传下载            │
└──────────────┬──────────────────────┘
               ▲ HTTP 直连
               │
┌──────────────┴──────────────────────┐
│     web-agent (Next.js 静态导出)      │
│  统一 HTTP 客户端请求 server-agent    │
│  运行环境：Electron 渲染进程          │
│          / 本机浏览器                │
│          / 局域网远程浏览器           │
└─────────────────────────────────────┘
```

### 关键变化

- **server-agent**：从 `localhost` 改为绑定 `0.0.0.0`，支持局域网访问
- **web-agent**：不再依赖 `window.electronAPI` 做数据请求，全部走 HTTP 直连
- **desktop 主进程**：只保留桌面专属能力（窗口管理、系统通知、快捷键、托盘），不再有 `database.ts` 等 HTTP 转发逻辑
- **Electron 专属能力降级**：浏览器模式下 `window.electronAPI` 不存在，桌面专属功能静默跳过

## 认证机制：账号注册 + JWT 登录

### 初始化引导（Setup）

1. server-agent 首次启动，检测数据库中是否有用户记录
2. 若无用户 → 标记为"未初始化"，除 auth 相关接口外所有 API 返回 401
3. web-agent 检测到未初始化 → 跳转 Setup 页面
4. Setup 流程：
   - Step 1：创建账号（用户名 + 密码）
   - Step 2：配置模型（选择 Provider、填写 API Key）
5. 注册完成后自动登录，签发 JWT

### 登录流程

1. web-agent 打开 → 检查 `localStorage` 中是否有有效 JWT
2. 无 token 或过期 → 跳转登录页
3. 首次使用（未注册）→ 跳 Setup 页
4. 已注册未登录 → 跳登录页
5. 已登录 → 进入主界面

所有环境（Electron / 本机浏览器 / 局域网）统一走登录页，不做自动登录特殊逻辑。

### Auth API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册（仅在无账号时可用，单用户限制） |
| POST | `/api/auth/login` | 登录，返回 JWT |
| GET | `/api/auth/status` | 返回是否已初始化、当前登录状态 |

### 安全设计

- 密码 bcrypt 哈希存储
- JWT 有效期 7 天（本地服务，不需要太短）
- NestJS `AuthGuard` 全局守卫，白名单放行 auth 接口
- CORS 白名单：`localhost:3001`（开发）、`file://`（Electron 静态导出）、可配置局域网来源

## 模块职责与代码组织

### packages/common — 通用 HTTP 封装

```
packages/common/src/api/
  └── client.ts    — axios 实例（baseURL、interceptor、JWT 注入、401 跳转）
```

- 基于 axios 封装
- interceptor 自动从 `localStorage` 读取 JWT 注入 `Authorization` 头
- 401 响应自动跳转登录页
- 支持 JSON 请求、文件上传（FormData）、SSE 流式（配合 fetch fallback）
- baseURL 默认 `http://localhost:3100`，局域网访问时从 `location.hostname` 推导

### libs/types — 通用请求/响应类型

- 通用分页类型（`PaginatedRequest`、`PaginatedResponse`）
- 通用返回体（`ApiResponse<T>`）
- 其他跨项目共享类型

### libs/types-agent（新建）— agent 专属类型

- Auth 相关 DTO（`LoginRequest`、`RegisterRequest`、`AuthStatus`）
- ModelConfig 相关 DTO
- Setting 相关 DTO
- 使用 Zod schema 定义，前后端共享校验

### apps/web-agent/src/rest/ — 具体 REST 接口 + Query hooks

```
apps/web-agent/src/rest/
  ├── auth.ts          — 登录/注册 API 函数 + TanStack Query hooks
  ├── model-config.ts  — 模型配置 API 函数 + hooks
  ├── settings.ts      — 设置 API 函数 + hooks
  └── index.ts
```

- React 侧用 TanStack Query 管理服务端状态
- API 函数（axios 调用）和 Query hooks 在同一文件中，按业务域组织

**职责分界：common 管"怎么发请求"，types/types-agent 管"请求长什么样"，web-agent/rest 管"发哪些请求"。**

## 迁移改造清单

### server-agent（加认证 + CORS）

| 文件 | 操作 | 说明 |
|------|------|------|
| `main.ts` | 改造 | 绑定 `0.0.0.0`，启用 CORS |
| `app.module.ts` | 改造 | 新增 AuthModule |
| `entities/user.entity.ts` | 新增 | 用户实体（username、password_hash） |
| `controllers/auth.controller.ts` | 新增 | register / login / status 接口 |
| `services/auth.service.ts` | 新增 | 注册、登录、JWT 签发 |
| `guards/auth.guard.ts` | 新增 | 全局 JWT 校验，白名单放行 auth 接口 |
| `controllers/setup.controller.ts` | 改造 | Setup 状态改为从 auth status 获取 |

### web-agent（去 IPC，改 HTTP 直连）

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/rest/` | 新增 | 各接口声明 + TanStack Query hooks |
| `app/page.tsx` | 改造 | 去掉 `window.electronAPI`，用 REST hooks |
| `app/setup/page.tsx` | 改造 | 合并注册账号 + 模型配置 |
| `app/login/page.tsx` | 新增 | 登录页 |
| `app/layout.tsx` | 改造 | TanStack QueryProvider + 全局登录态检查 |
| `components/setup/` | 改造 | 适配新数据流 |
| `types/electron.d.ts` | 删除 | 不再需要 |

### desktop（瘦身）

| 文件 | 操作 | 说明 |
|------|------|------|
| `database.ts` | 删除 | 不再需要主进程代发 HTTP |
| `ipc-handlers.ts` | 大幅精简 | 删除所有 API 代理 handler，仅保留桌面专属能力 |
| `preload.ts` | 大幅精简 | 删除 API 相关暴露，仅保留桌面专属 API |
| `main.ts` | 小改 | 去掉 `getSetupStatus` 判断，窗口始终加载根路由，由前端路由决定跳转 |

### libs / packages

| 文件 | 操作 | 说明 |
|------|------|------|
| `libs/types-agent/` | 新增 | Agent 专属 DTO（Zod schema） |
| `libs/types/src/` | 改造 | 通用分页、通用返回体类型 |
| `packages/common/src/api/client.ts` | 新增 | axios 实例封装 |

## 迁移顺序

1. **基础设施**：`libs/types-agent` + `libs/types` 通用类型 + `packages/common` axios 封装
2. **server-agent 加认证**：User entity + AuthModule + AuthGuard + CORS
3. **web-agent 改直连**：新建 `rest/`、登录页、改造 Setup 和主页
4. **desktop 瘦身**：删除 `database.ts`、精简 IPC / preload / main

每一步可独立验证，逐步推进。
