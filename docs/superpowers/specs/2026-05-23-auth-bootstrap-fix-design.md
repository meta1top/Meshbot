# 登录态修复 + profile 引导流程 设计

> 状态：设计已确认，待 plan
> 范围：本地轨（web-agent + server-agent + packages/web-common + libs/types-agent）
> 日期：2026-05-23

## 1. 问题与目标

三个相关问题：

1. **登录态判断失效** —— 前端靠 `localStorage` 的 `meshbot_access_token` 是否有值判断登录，但该值始终是 `undefined`。根因是登录响应没被正确保存（见问题 2）。期望：用一个受保护的 profile 接口判断登录态——401 去登录，200 加载用户信息到全局状态。

2. **登录 token 未保存** —— `POST /api/auth/login` 实际返回了 `access_token`，但前端没存进 `localStorage`。

3. **setup-status 加载时机** —— 当前 `AuthGuard` 启动就无条件拉 `/api/setup-status` 阻塞所有路径。期望：只在判定为未登录、需要去登录页时，才 loading 加载 setup-status 决定是否进初始化页。

**根因（问题 1+2 同源）**：server-agent 全局 `ResponseInterceptor` 把每个成功响应包成 envelope `{ success, code, message, data, timestamp, path, traceId }`。前端 `apiClient`（`packages/web-common/src/api/client.ts`）的响应拦截器只处理 401，**不解包**。所以 `const { data } = await apiClient.post(...)` 拿到的 `data` 是整个 envelope，业务数据在 `data.data`：

- `login()` 读 `data.access_token` → `undefined` → `setAccessToken(undefined)` → token 没存。
- `fetchAuthStatus()` 读 `data.needsSetup` → `undefined`。

## 2. 架构概览

修复拆为 4 个单元：

| 单元 | 位置 | 职责 |
|---|---|---|
| envelope 统一解包 | `packages/web-common/src/api/client.ts` | apiClient 响应拦截器识别并解包 envelope；连带清理各 rest 文件的重复解包 |
| profile 端点 | `apps/server-agent` AuthController + AuthService | 新增受 JWT 保护的 `GET /api/auth/profile` |
| Jotai profile 全局状态 | `apps/web-agent/src/atoms/` | 引入 jotai + jotai-tanstack-query，profile 查询即 atom |
| AuthGuard 重构 | `apps/web-agent/src/components/auth-guard.tsx` | 启动判定：profile 优先，401 时才拉 setup-status |

## 3. envelope 统一解包

### apiClient 响应拦截器解包

在 `packages/web-common/src/api/client.ts` 的 `client.interceptors.response.use` 成功回调里，识别 envelope 并解包：

- 判定：响应体是对象，且同时含 `success` 与 `data` 字段 → 视为 envelope，把 `response.data` 替换为 `response.data.data`。
- 否则原样返回（兼容 `@SkipResponseEnvelope()` 路由——health / metrics / Swagger / SSE 等直返裸 shape）。
- 401 错误处理逻辑（现有的 error 回调）保持不变。

一处修复，`auth` / `model-config` / `session` 所有 `apiClient` 调用点自动拿到正确的内层 payload。

### 连带清理：删除各 rest 文件的重复解包

- `apps/web-agent/src/rest/session.ts` 当前有自己的 `SuccessEnvelope` 接口 + `unwrap<T>()` helper（Task 10 加的，因为当时 apiClient 不解包）。apiClient 统一解包后，`unwrap` 收到的已是解包后的 payload——它的 `"success" in body` 判定不成立，走 `return body as T` 原样返回，功能不破，但成了死代码。**删除 `SuccessEnvelope` + `unwrap`**，4 个函数直接用 `data`。
- 审查 `apps/web-agent/src/rest/model-config.ts`、`apps/web-agent/src/rest/auth.ts`——确认统一解包后没有遗留的错误假设（model-config 之前也有同样隐藏 bug，统一解包后自动修正；确认其调用点 `data` 用法正确）。
- 检查 `apps/web-agent/src/components/auth-guard.tsx` 里那段手写 `fetch('/api/setup-status')`（不走 apiClient）——它自己 `res.json()` 后直接当 `AuthStatus` 用，也是被 envelope 影响的。第 5 节 AuthGuard 重构会改写这段，届时一并修正（走 apiClient 或手动解包）。

## 4. 后端新增 `GET /api/auth/profile`

`apps/server-agent/src/controllers/auth.controller.ts` 新增端点：

- `@Get("profile")` —— **不加 `@Public()`**，走全局 `JwtAuthGuard` 保护。
- 已登录（JWT 有效）→ 200，返回 `{ id, username }`。
- 未登录 / token 过期 / 无 token → `JwtAuthGuard` 自动 401。
- 返回体走全局 `ResponseInterceptor` 包 envelope（与其他端点一致）。

实现：`AuthController.profile` 从 `req.user`（JWT strategy 的 `validate` 已返回 `{ id, username }`）取 `id`，调 `AuthService.getProfile(id)` **查库**确认用户仍存在并返回最新 `{ id, username }`。`AuthService` 已有 `validateUser(userId): Promise<User | null>`——`getProfile` 复用它：查不到则抛 `AppError(AUTH_INVALID_CREDENTIALS)` 或等价的未授权错误（正常情况下 JWT 有效则用户必存在，这是防御性处理）。

类型：`UserInfo { id, username }` 已存在于 `libs/types-agent/src/auth.ts`，直接复用作为前端的返回类型。

> 取 `req.user` 用 NestJS 的 `@Req()` 或自定义 `@CurrentUser()` 装饰器——按 server-agent 现有惯例（若无 `@CurrentUser` 装饰器则用 `@Req()`）。

## 5. 前端 Jotai + profile 全局状态

### 依赖

`apps/web-agent` 新增 `jotai`、`jotai-tanstack-query`。

### profile 查询 atom

新文件 `apps/web-agent/src/atoms/auth.ts`：

- `profileQueryAtom` —— `atomWithQuery`（来自 `jotai-tanstack-query`）包 `GET /api/auth/profile`：
  - `queryKey: ['auth','profile']`
  - `queryFn`：调 `apiClient.get('/api/auth/profile')`，返回 `UserInfo`
  - `retry: false`（401 不重试）
- 派生 atom：
  - `currentUserAtom` —— 从 `profileQueryAtom` 取 `UserInfo` 或 `null`
  - `isAuthenticatedAtom` —— profile 查询成功且有 data

### Provider 接线

`atomWithQuery` 需要 react-query 的 `QueryClient` 在 Jotai 作用域可见，且必须复用现有 `QueryClient`（不新建——否则 cache 分裂）。

`apps/web-agent/src/components/providers.tsx` 当前：`QueryClientProvider` → `AuthGuard`。改为：`QueryClientProvider` → Jotai `Provider` → `AuthGuard`。用 `jotai-tanstack-query` 的 `queryClientAtom` + `useHydrateAtoms`（一个内层 `HydrateAtoms` 组件）把现有 `queryClient` 注入 `queryClientAtom`，使 `atomWithQuery` 复用同一个 client。

### 组件读取

任何组件 `useAtomValue(currentUserAtom)` 取当前用户。登录成功后 `login()` 存完 token，需触发 profile atom 重新拉——`queryClient.invalidateQueries({ queryKey: ['auth','profile'] })`。

`useAuthStatus`（setup-status）保持现状用普通 `useQuery`——它不是全局长期状态，只在登录引导时用。

## 6. AuthGuard 重构 —— 启动判定流程

`apps/web-agent/src/components/auth-guard.tsx` 重写。新流程 **profile 优先，setup-status 仅在需要时拉**：

1. **启动 loading** → 读 `profileQueryAtom`（发 `GET /api/auth/profile`）。期间显示 `SplashScreen`。

2. **profile 200**（已登录）：
   - `currentUserAtom` 有值，用户信息进全局状态。
   - 当前在公开路由（`/login` `/setup`）→ `router.replace('/')`。
   - 否则放行渲染 `children`。
   - **不拉 setup-status**。

3. **profile 401**（未登录）→ 此时**才**拉 `GET /api/setup-status`（仍 loading）：
   - `needsSetup: true` → `router.replace('/setup')`。
   - `needsSetup: false` → `router.replace('/login')`。
   - 初始化 / 登录两种 401 由 setup-status 正确区分。

4. **profile 请求失败（非 401，如网络错误 / 后端没起）** → 沿用现有容错：不强制跳转，放行（避免后端未就绪时整个 app 卡死）。

`SplashScreen` 覆盖 step 1 的 profile 请求 + step 3 的 setup-status 请求，直到路由判定完成。

### 与 apiClient 401 拦截器的协作

`apiClient` 的响应 error 拦截器现有逻辑：401 时清 token，且若当前路径不是 `/login` `/setup` 则 `window.location.href = '/login'`。

- profile 的 401 是 `AuthGuard` 的预期分支。`AuthGuard` 用 `atomWithQuery` 发 profile——若该请求经 `apiClient`，401 会触发 apiClient 拦截器的硬跳转 `/login`，与 `AuthGuard` 的 step 3 分流（可能要去 `/setup`）打架。
- **决策**：profile 请求需绕过 apiClient 的 401 硬跳转。两种实现取其一（实施时定）：
  - (a) profile 的 `queryFn` 用一个不带 401-跳转拦截器的轻量请求（裸 `fetch` 或独立 axios 实例），让 `AuthGuard` 完全掌控 401 分流。
  - (b) 给 apiClient 401 拦截器加豁免：识别 profile 请求 URL 时不硬跳转。
  - 推荐 (a)——profile 是引导探活请求，本就该独立于业务 apiClient 的副作用。`AuthGuard` step 3 已完整处理 profile 401 的去向。

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| login 响应 envelope | apiClient 统一解包，`data.access_token` 正确，token 存入 localStorage |
| profile 401 | AuthGuard step 3：拉 setup-status 分流到 /setup 或 /login，不弹错 |
| profile 网络失败（非 401） | AuthGuard step 4：容错放行，不卡死 app |
| setup-status 也失败 | 沿用现有 `fetchFailed` 容错放行 |
| JWT 有效但用户被删 | profile 查库未命中 → 后端返回未授权错误 → 前端当 401 处理 |
| apiClient 401 硬跳转 vs AuthGuard 分流 | profile 请求绕过 apiClient 的 401 拦截器（第 6 节决策 a）|

## 8. 测试

- **后端**：`GET /api/auth/profile` —— Jest，覆盖有效 JWT 返回用户、无 JWT 401、用户被删的防御分支。
- **前端 apiClient 解包**：给响应拦截器的解包逻辑加单测（envelope 输入解包 / 非 envelope 输入原样 / 401 error 不变）。web-common 是否有既有单测惯例——若有则加，若无则至少手动验证。
- **AuthGuard 三分支**：profile 200 已登录、profile 401→needsSetup、profile 401→login。前端无组件单测惯例——以 `pnpm build` + 手动冒烟为准。
- **回归**：`pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm check`。

## 9. 影响面与注意点

- `apiClient` 解包是全局行为变更——`rest/session.ts` / `rest/model-config.ts` / `rest/auth.ts` 所有调用点都受影响。统一解包后它们自动变正确，但必须逐一确认（session 之前靠自己的 unwrap、model-config 之前是 bug 状态、auth 之前是 bug 状态）。
- `@SkipResponseEnvelope()` 路由（health 等）不被解包——解包判定靠 `success` + `data` 字段同时存在，裸响应不命中。
- Jotai `Provider` 必须在 `QueryClientProvider` 内层，且复用同一个 `QueryClient`。
- 删除 `rest/session.ts` 的 `unwrap` 后，`session.ts` 的 4 个函数签名不变（返回类型不变），仅内部实现简化。
