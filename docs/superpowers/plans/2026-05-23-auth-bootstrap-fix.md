# 登录态修复 + profile 引导流程 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复登录 token 未保存的根因（apiClient 不解包 envelope），新增 profile 端点，引入 Jotai 全局用户状态，重构 AuthGuard 启动判定为 profile 优先。

**Architecture:** 后端全局 `ResponseInterceptor` 把响应包成 `{success,data,...}` envelope；前端 `apiClient` 不解包导致 `data.access_token` 取到 undefined。修复方式：apiClient 响应拦截器统一解包，连带删除各 rest 文件的重复解包。后端加受 JWT 保护的 `GET /api/auth/profile`。前端引入 `jotai` + `jotai-tanstack-query`，profile 查询即 atom；`AuthGuard` 改为 profile 优先——200 已登录、401 才拉 setup-status 分流到 /login 或 /setup。

**Tech Stack:** NestJS 11、axios、Next.js 15、@tanstack/react-query、jotai、jotai-tanstack-query。

---

## 背景与约定（实施前必读）

- **仓库**：meshbot monorepo（pnpm + Turbo）。当前分支 `feat/session-streaming`。本特性只动本地轨：`apps/web-agent`、`apps/server-agent`、`packages/web-common`、`libs/types-agent`。
- **根因**：server-agent `main.ts` 全局注册 `ResponseInterceptor`，把成功响应包成 `{ success, code, message, data, timestamp, path, traceId }`。前端 `apiClient`（`packages/web-common/src/api/client.ts`）响应拦截器只处理 401，不解包 → `const { data } = await apiClient.xxx()` 的 `data` 是整个 envelope。
- **测试**：server-agent 用 Jest；web-common 检查是否有既有单测惯例。
- **静态围栏**：改 `*.controller.ts` / `*.service.ts` 后 commit 前跑 `pnpm check`。
- **提交信息**：中文，conventional commits，结尾加 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。
- **格式**：commit 前 `pnpm format`（Biome）。禁止在 `if` 前一行放注释。公开方法中文 JSDoc。
- **不用 `--no-verify`**。

## 文件结构总览

**新建：**
| 文件 | 职责 |
|---|---|
| `apps/web-agent/src/atoms/auth.ts` | profile 查询 atom（atomWithQuery）+ 派生 currentUser / isAuthenticated atom |
| `apps/web-agent/src/lib/profile-client.ts` | 独立于 apiClient 的轻量 profile 请求（绕过 401 硬跳转） |

**修改：**
| 文件 | 改动 |
|---|---|
| `packages/web-common/src/api/client.ts` | 响应拦截器统一解包 envelope |
| `apps/server-agent/src/services/auth.service.ts` | 新增 `getProfile(userId)` |
| `apps/server-agent/src/controllers/auth.controller.ts` | 新增 `GET /api/auth/profile` |
| `apps/web-agent/src/rest/session.ts` | 删除冗余 `unwrap` / `SuccessEnvelope` |
| `apps/web-agent/src/rest/auth.ts` | profile fetch 函数 + 确认解包后 login/fetchAuthStatus 正确 |
| `apps/web-agent/src/components/providers.tsx` | 加 Jotai Provider + queryClient 注入 |
| `apps/web-agent/src/components/auth-guard.tsx` | 重写：profile 优先判定 |
| `apps/web-agent/package.json` | 加 `jotai`、`jotai-tanstack-query` |

---

## Task 1：apiClient 统一解包 envelope

**Files:**
- Modify: `packages/web-common/src/api/client.ts`
- Test: `packages/web-common/src/api/client.spec.ts`（新建，若 web-common 有既有单测惯例）

- [ ] **Step 1: 确认 web-common 测试惯例**

Run: `ls packages/web-common/src/**/*.spec.ts packages/web-common/src/**/*.test.ts 2>/dev/null; cat packages/web-common/package.json | grep -A3 '"scripts"'`
若 web-common 有测试配置 → 写 Step 2 的单测。若完全没有测试基建 → 跳过单测，本 Task 仅改实现 + 靠 Task 7 的回归冒烟验证；在报告里说明。

- [ ] **Step 2: 写解包测试（仅当 web-common 有测试基建）**

`packages/web-common/src/api/client.spec.ts` —— 测解包逻辑。把解包逻辑抽成一个可单测的纯函数 `unwrapEnvelope`（Step 3 会导出它）：

```ts
import { describe, expect, it } from "@jest/globals";
import { unwrapEnvelope } from "./client";

describe("unwrapEnvelope", () => {
  it("识别 envelope 并取内层 data", () => {
    const body = { success: true, code: 0, data: { access_token: "tok" } };
    expect(unwrapEnvelope(body)).toEqual({ access_token: "tok" });
  });

  it("非 envelope（无 success/data）原样返回", () => {
    const body = { foo: "bar" };
    expect(unwrapEnvelope(body)).toEqual({ foo: "bar" });
  });

  it("null / 原始值原样返回", () => {
    expect(unwrapEnvelope(null)).toBeNull();
    expect(unwrapEnvelope("plain")).toBe("plain");
  });
});
```

- [ ] **Step 3: 改 client.ts**

`packages/web-common/src/api/client.ts` —— 在 `createApiClient` 之前加导出的纯函数 `unwrapEnvelope`，并在响应成功拦截器里用它。

加这个函数（放在文件里 `createApiClient` 之前）：

```ts
/**
 * 解包 server 端统一响应 envelope。
 *
 * server 全局 ResponseInterceptor 把成功响应包成
 * `{ success, code, message, data, ... }`。识别该结构（同时含 success 与
 * data 字段）则取内层 `data`；否则（@SkipResponseEnvelope 路由 / 裸响应）原样返回。
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (
    body !== null &&
    typeof body === "object" &&
    "success" in body &&
    "data" in body
  ) {
    return (body as { data: unknown }).data;
  }
  return body;
}
```

把成功拦截器从 `(response) => response` 改为：

```ts
  client.interceptors.response.use(
    (response) => {
      response.data = unwrapEnvelope(response.data);
      return response;
    },
    (error) => {
```

（error 回调保持完全不变。）

- [ ] **Step 4: 运行测试**

若写了 Step 2：Run `pnpm --filter @meshbot/web-common test`（或该包的测试命令）— expect PASS（3 cases）。
若无测试基建：Run `pnpm --filter @meshbot/web-common build` — expect 编译无错。

- [ ] **Step 5: 导出确认**

确认 `packages/web-common/src/index.ts` 是否需要导出 `unwrapEnvelope`。它主要是内部用 + 单测用。若 `check:dead`（死导出围栏）会扫到它且它没被 index 导出也无外部引用——Task 1 的单测引用它（同包内 import）。保守做法：不加进 `index.ts` 的 public 导出（它不是给消费方用的 API）。`check:dead` 扫 `packages/` 与否——若它报 `unwrapEnvelope` 死导出，再加进 index.ts。本 Task 先不导出，Step 6 commit 时若 `pnpm check` 报死导出再处理。

- [ ] **Step 6: 提交**

```bash
pnpm format
git add packages/web-common/src/api/client.ts packages/web-common/src/api/client.spec.ts
git commit -m "fix(web-common): apiClient 响应拦截器统一解包 envelope

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
（若没写 spec 文件，从 `git add` 里去掉它。）

---

## Task 2：清理 rest 文件的重复解包

apiClient 统一解包后，`rest/session.ts` 自带的 `unwrap` 成了冗余二次解包。`rest/model-config.ts` / `rest/auth.ts` 之前的 bug 状态自动修正——但需逐一确认。

**Files:**
- Modify: `apps/web-agent/src/rest/session.ts`
- Verify (可能 Modify): `apps/web-agent/src/rest/model-config.ts`, `apps/web-agent/src/rest/auth.ts`

- [ ] **Step 1: 删除 session.ts 的 unwrap**

读 `apps/web-agent/src/rest/session.ts`。它当前有：`SuccessEnvelope<T>` 接口、`unwrap<T>()` 函数、`AppendMessagePayload` 接口，4 个函数（`createSession`/`appendMessage`/`fetchHistory`/`fetchPending`）每个都 `apiClient.xxx<SuccessEnvelope<X> | X>(...)` 然后 `unwrap(data)`。

apiClient 现在已统一解包，`data` 直接就是内层 payload。改为：
- 删除 `SuccessEnvelope<T>` 接口和 `unwrap<T>()` 函数。
- 保留 `AppendMessagePayload` 接口（它是真实业务类型，不是 envelope）。
- 4 个函数的 `apiClient` 泛型去掉 `SuccessEnvelope<X> |` union，直接用 payload 类型；去掉 `unwrap(data)` 调用，直接 `return data`（或 `data.sessionId` 等）。

改写后的 `apps/web-agent/src/rest/session.ts`：

```ts
"use client";

import type { HistoryResponse, PendingResponse } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** appendMessage 返回的业务 payload。 */
interface AppendMessagePayload {
  messageId: string;
  queued: boolean;
}

/** 创建会话，返回 sessionId。 */
export async function createSession(content: string): Promise<string> {
  const { data } = await apiClient.post<{ sessionId: string }>(
    "/api/sessions",
    { content },
  );
  return data.sessionId;
}

/** 向会话追加一条消息。 */
export async function appendMessage(
  sessionId: string,
  content: string,
): Promise<AppendMessagePayload> {
  const { data } = await apiClient.post<AppendMessagePayload>(
    `/api/sessions/${sessionId}/messages`,
    { content },
  );
  return data;
}

/** 取会话已处理历史 + inflight。 */
export async function fetchHistory(
  sessionId: string,
): Promise<HistoryResponse> {
  const { data } = await apiClient.get<HistoryResponse>(
    `/api/sessions/${sessionId}/history`,
  );
  return data;
}

/** 取会话排队中的用户消息。 */
export async function fetchPending(
  sessionId: string,
): Promise<PendingResponse> {
  const { data } = await apiClient.get<PendingResponse>(
    `/api/sessions/${sessionId}/pending`,
  );
  return data;
}
```

- [ ] **Step 2: 确认 model-config.ts**

读 `apps/web-agent/src/rest/model-config.ts`。它的函数都是 `const { data } = await apiClient.get<T>(...)` 然后 `return data`。apiClient 统一解包后，`data` 直接是 `T`——这正是它原本期望的类型。**无需改动**（之前是 bug：`data` 实际是 envelope；现在自动修正）。确认其类型标注 `<ProviderDef[]>` / `<ModelConfig[]>` / `<ModelConfig>` 与解包后实际 payload 一致——是的。报告确认，不改文件。

- [ ] **Step 3: 确认 auth.ts 的 login / fetchAuthStatus**

读 `apps/web-agent/src/rest/auth.ts`。`login()` 当前 `const { data } = await apiClient.post<LoginResponse>(...)` 然后 `setAccessToken(data.access_token)`。apiClient 解包后 `data` 是 `LoginResponse`（`{ access_token }`）——`data.access_token` 现在正确。`register()` 同理。`fetchAuthStatus()` 的 `data` 现在是 `AuthStatus`——正确。**这三个函数无需改动**（解包修复后自动正确）。Task 3 会给 auth.ts 加 profile 函数，但这里确认现有函数无需改即可。报告确认。

- [ ] **Step 4: 构建确认**

Run: `pnpm --filter @meshbot/web-agent build` — expect 构建成功（静态导出）。若 `@meshbot/web-common` dist 旧，先 `pnpm --filter @meshbot/web-common build`。

- [ ] **Step 5: 提交**

```bash
pnpm format
git add apps/web-agent/src/rest/session.ts
git commit -m "refactor(web-agent): 删除 rest/session 冗余 unwrap（apiClient 已统一解包）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3：后端 `GET /api/auth/profile` 端点

**Files:**
- Modify: `apps/server-agent/src/services/auth.service.ts`
- Modify: `apps/server-agent/src/controllers/auth.controller.ts`
- Test: `apps/server-agent/test/e2e/auth-profile.e2e.spec.ts`（新建）

- [ ] **Step 1: 给 AuthService 加 getProfile**

`apps/server-agent/src/services/auth.service.ts` —— 在 class 内加一个方法（`AuthService` 已有 `validateUser(userId): Promise<User | null>`，复用它）：

```ts
  /**
   * 取当前用户 profile。userId 来自已验证的 JWT。
   *
   * 查库确认用户仍存在；不存在则抛未授权错误（JWT 有效但用户被删的防御分支）。
   */
  async getProfile(userId: string): Promise<{ id: string; username: string }> {
    const user = await this.validateUser(userId);
    if (!user) {
      throw new AppError(AgentErrorCode.AUTH_INVALID_CREDENTIALS);
    }
    return { id: user.id, username: user.username };
  }
```

（`AppError` 和 `AgentErrorCode` 已在 `auth.service.ts` 顶部 import——确认。`AgentErrorCode.AUTH_INVALID_CREDENTIALS` = code 3002，复用作"未授权"语义。）

- [ ] **Step 2: 给 AuthController 加 profile 端点**

`apps/server-agent/src/controllers/auth.controller.ts` —— 加一个 `@Get("profile")`，**不加 `@Public()`**（走全局 JwtAuthGuard）。用 `@Req()` 取 `req.user`（JWT strategy 的 `validate` 返回 `{ id, username }`）。

在 import 区加 `Req`：`import { Body, Controller, Get, Post, Req } from "@nestjs/common";`，并 `import type { Request } from "express";`。

加方法：

```ts
  /** 取当前登录用户 profile（受 JWT 保护，未登录返回 401）。 */
  @Get("profile")
  profile(@Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.authService.getProfile(user.id);
  }
```

（`req.user` 的类型——JWT strategy `validate` 返回 `{ id, username }`，passport 挂到 `req.user`。用 `as` 断言为 `{ id, username }`。若 server-agent 已有 `req.user` 的类型扩展则用它；没有就用 `as`。）

- [ ] **Step 3: 写 e2e 测试**

`apps/server-agent/test/e2e/auth-profile.e2e.spec.ts` —— 参照已有 e2e（`session.e2e.spec.ts`、`dto-i18n.spec.ts`）的 bootstrap 风格。覆盖：无 token → 401；有效 token → 200 返回用户。

```ts
import { TxTypeOrmModule } from "@meshbot/common";
import { type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import request from "supertest";
import { AuthController } from "../../src/controllers/auth.controller";
import { User } from "../../src/entities/user.entity";
import { JwtAuthGuard } from "../../src/guards/jwt-auth.guard";
import { AuthService } from "../../src/services/auth.service";
import { JWT_SECRET, JwtStrategy } from "../../src/strategies/jwt.strategy";

describe("Auth profile e2e", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [User],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([User]),
        PassportModule,
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: "7d" },
        }),
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const reg = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({ username: "alice", password: "pw123456" });
    token = reg.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/auth/profile 无 token 返回 401", async () => {
    await request(app.getHttpServer()).get("/api/auth/profile").expect(401);
  });

  it("GET /api/auth/profile 有效 token 返回当前用户", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.username).toBe("alice");
    expect(typeof res.body.id).toBe("string");
  });
});
```

IMPORTANT：本测试模块手动注册 `JwtAuthGuard` 为 `APP_GUARD`——因为 profile 端点依赖它做鉴权。`register` 的返回 `reg.body.access_token`——这个测试模块没注册 `ResponseInterceptor`，所以 `reg.body` 是裸 `{ access_token }`（不是 envelope）。`profile` 的 `res.body` 同理是裸 `{ id, username }`。验证：读 `apps/server-agent/test/e2e/session.e2e.spec.ts` 确认 e2e 模块确实不挂 interceptor——若 session e2e 用了不同模式，对齐它。`@meshbot/types-agent` 的 `JwtAuthGuard` import 路径、`JwtStrategy` 等以实际文件为准。

- [ ] **Step 4: 运行 e2e**

Run: `pnpm test -- auth-profile`（root Jest）— expect PASS（2 cases）。文件名 `.e2e.spec.ts` 对齐 `session.e2e.spec.ts` 的命名（jest testMatch `**/?(*.)+(spec|test).ts`）。

- [ ] **Step 5: 构建 + 围栏**

Run: `pnpm --filter @meshbot/server-agent build && pnpm check` — expect 构建无错，6 围栏 0 finding。

- [ ] **Step 6: 提交**

```bash
pnpm format
git add apps/server-agent/src/services/auth.service.ts apps/server-agent/src/controllers/auth.controller.ts apps/server-agent/test/e2e/auth-profile.e2e.spec.ts
git commit -m "feat(auth): 新增受 JWT 保护的 GET /api/auth/profile

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4：前端 profile 请求 + auth.ts profile 函数

profile 请求需绕过 apiClient 的 401 硬跳转（apiClient 401 拦截器会 `window.location.href = '/login'`，与 AuthGuard 的 401→可能去 /setup 分流打架）。用一个独立轻量请求。

**Files:**
- Create: `apps/web-agent/src/lib/profile-client.ts`
- Modify: `apps/web-agent/src/rest/auth.ts`

- [ ] **Step 1: 写 profile-client.ts**

`apps/web-agent/src/lib/profile-client.ts` —— 一个独立的 profile 请求，不经 apiClient（避免 401 副作用）。用裸 `fetch`，自己解包 envelope，401 抛特定错误让 AuthGuard 识别。

```ts
"use client";

import type { UserInfo } from "@meshbot/types-agent";
import { getAccessToken, getBrowserApiBaseUrl } from "@meshbot/web-common";

/** profile 请求未授权（401）—— AuthGuard 据此走 setup-status 分流。 */
export class ProfileUnauthorizedError extends Error {
  constructor() {
    super("profile unauthorized");
    this.name = "ProfileUnauthorizedError";
  }
}

/**
 * 请求当前用户 profile。
 *
 * 独立于 apiClient —— apiClient 的 401 拦截器会硬跳转 /login，与 AuthGuard
 * 的 401 分流（可能要去 /setup）冲突。这里 401 抛 ProfileUnauthorizedError
 * 交给 AuthGuard 决策。响应走 server envelope，手动取内层 data。
 */
export async function fetchProfile(): Promise<UserInfo> {
  const base = getBrowserApiBaseUrl();
  const token = getAccessToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${base}/api/auth/profile`, { headers });
  if (res.status === 401) {
    throw new ProfileUnauthorizedError();
  }
  if (!res.ok) {
    throw new Error(`profile request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: UserInfo } & UserInfo;
  return (body.data ?? body) as UserInfo;
}
```

（`body.data ?? body` —— server envelope 时取 `data`，裸响应时取 body 本身，与 apiClient 的 `unwrapEnvelope` 同样宽容。`UserInfo` 类型已存在于 `@meshbot/types-agent`。）

- [ ] **Step 2: rest/auth.ts 导出 profile 入口**

`apps/web-agent/src/rest/auth.ts` —— 不需要给 auth.ts 加东西用于 atom（atom 会直接用 `profile-client.ts` 的 `fetchProfile`）。但为保持 rest 层一致，可以从 `rest/auth.ts` re-export `fetchProfile`：在文件末尾加：

```ts
export { fetchProfile, ProfileUnauthorizedError } from "@/lib/profile-client";
```

（这样 atom 与其他代码统一从 `@/rest/auth` 取。若你认为 atom 直接 import `@/lib/profile-client` 更直接也可——二选一，保持一处即可。本 plan 选 re-export 以集中 auth 相关入口。）

- [ ] **Step 3: 构建确认**

Run: `pnpm --filter @meshbot/web-agent build` — expect 成功。

- [ ] **Step 4: 提交**

```bash
pnpm format
git add apps/web-agent/src/lib/profile-client.ts apps/web-agent/src/rest/auth.ts
git commit -m "feat(web-agent): 新增独立 profile 请求（绕过 apiClient 401 跳转）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5：引入 Jotai + profile atom + Provider 接线

**Files:**
- Modify: `apps/web-agent/package.json`（加依赖）
- Create: `apps/web-agent/src/atoms/auth.ts`
- Modify: `apps/web-agent/src/components/providers.tsx`

- [ ] **Step 1: 装依赖**

Run: `pnpm --filter @meshbot/web-agent add jotai jotai-tanstack-query`
Expect: `apps/web-agent/package.json` 出现 `jotai` 和 `jotai-tanstack-query`。

- [ ] **Step 2: 写 auth atom**

`apps/web-agent/src/atoms/auth.ts`：

```ts
"use client";

import type { UserInfo } from "@meshbot/types-agent";
import { atomWithQuery } from "jotai-tanstack-query";
import { atom } from "jotai";
import { fetchProfile, ProfileUnauthorizedError } from "@/rest/auth";

/**
 * profile 查询 atom —— 即网络请求又是全局状态单一来源。
 *
 * 401（ProfileUnauthorizedError）不重试。组件通过 currentUserAtom /
 * isAuthenticatedAtom 读派生状态。
 */
export const profileQueryAtom = atomWithQuery<UserInfo>(() => ({
  queryKey: ["auth", "profile"],
  queryFn: fetchProfile,
  retry: (_failureCount, error) => !(error instanceof ProfileUnauthorizedError),
  staleTime: 5 * 60 * 1000,
}));

/** 当前登录用户；未登录 / 加载中为 null。 */
export const currentUserAtom = atom((get) => {
  const query = get(profileQueryAtom);
  return query.data ?? null;
});

/** 是否已登录（profile 查询成功且有数据）。 */
export const isAuthenticatedAtom = atom((get) => {
  const query = get(profileQueryAtom);
  return query.isSuccess && query.data != null;
});
```

VERIFY API：`atomWithQuery` 来自 `jotai-tanstack-query`；其 `get` 返回的对象形如 react-query 的 result（`.data` / `.isSuccess` / `.isLoading` / `.error` / `.isError`）。`retry` 接受函数 `(failureCount, error) => boolean`——与 react-query 一致。若安装的 `jotai-tanstack-query` 版本 API 有差异（如 `atomWithQuery` 的签名、result 字段名），按实际版本调整并在报告里说明。`import` 顺序 Biome 会自动排。

- [ ] **Step 3: 改 providers.tsx 接线 Jotai**

`apps/web-agent/src/components/providers.tsx` —— 在 `QueryClientProvider` 内层加 Jotai `Provider`，并把现有 `queryClient` 注入 `jotai-tanstack-query` 的 `queryClientAtom`，使 `atomWithQuery` 复用同一个 client。

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, useStore } from "jotai";
import { useHydrateAtoms } from "jotai/utils";
import { queryClientAtom } from "jotai-tanstack-query";
import { useState } from "react";
import { AuthGuard } from "@/components/auth-guard";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        networkMode: "always",
      },
    },
  });
}

/** 把现有 QueryClient 注入 jotai 的 queryClientAtom，让 atomWithQuery 复用它。 */
function HydrateQueryClient({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: React.ReactNode;
}) {
  useHydrateAtoms([[queryClientAtom, queryClient]]);
  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider>
        <HydrateQueryClient queryClient={queryClient}>
          <AuthGuard>{children}</AuthGuard>
        </HydrateQueryClient>
      </JotaiProvider>
    </QueryClientProvider>
  );
}
```

NOTE：`useStore` import 上面列了但若 `useHydrateAtoms` 方案不需要它就去掉——`useHydrateAtoms` 在默认 store 下用 `[[queryClientAtom, queryClient]]` 即可。VERIFY：`jotai-tanstack-query` 导出 `queryClientAtom`；`useHydrateAtoms` 来自 `jotai/utils`。若实际 API 不同（如新版 `jotai-tanstack-query` 用别的接线方式），按文档接线——目标是 `atomWithQuery` 用到的 QueryClient 与 `QueryClientProvider` 的是同一个。报告实际用法。

- [ ] **Step 4: 构建确认**

Run: `pnpm --filter @meshbot/web-agent build` — expect 成功。这一步会暴露 `jotai-tanstack-query` 的 API 是否对——若编译错，按实际 API 修正 atom / providers。

- [ ] **Step 5: 提交**

```bash
pnpm format
git add apps/web-agent/src/atoms/auth.ts apps/web-agent/src/components/providers.tsx apps/web-agent/package.json pnpm-lock.yaml
git commit -m "feat(web-agent): 引入 jotai，profile 查询 atom + Provider 接线

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6：AuthGuard 重构 —— profile 优先判定

**Files:**
- Modify: `apps/web-agent/src/components/auth-guard.tsx`

- [ ] **Step 1: 重写 auth-guard.tsx**

读当前 `apps/web-agent/src/components/auth-guard.tsx`（含 `SplashScreen`）。重写 `AuthGuard`：profile 优先，401 才拉 setup-status。`SplashScreen` 组件保留不变。

新 `AuthGuard` 逻辑：

```tsx
"use client";

import { getBrowserApiBaseUrl } from "@meshbot/web-common";
import type { AuthStatus } from "@meshbot/types-agent";
import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { profileQueryAtom } from "@/atoms/auth";

const PUBLIC_ROUTES = ["/login", "/setup"];

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const profile = useAtomValue(profileQueryAtom);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (profile.isPending) {
      return;
    }

    let cancelled = false;

    // profile 成功：已登录
    if (profile.isSuccess && profile.data) {
      if (PUBLIC_ROUTES.includes(pathname)) {
        router.replace("/");
        return;
      }
      setResolved(true);
      return;
    }

    // profile 失败：区分 401（未登录）与网络错误
    const status = (profile.error as { name?: string } | null)?.name;
    const isUnauthorized = status === "ProfileUnauthorizedError";

    if (!isUnauthorized) {
      // 网络错误等：容错放行，避免后端未就绪卡死
      setResolved(true);
      return;
    }

    // 401 未登录：拉 setup-status 分流
    void fetchSetupStatus()
      .then((setup) => {
        if (cancelled) {
          return;
        }
        if (setup.needsSetup) {
          if (pathname !== "/setup") {
            router.replace("/setup");
            return;
          }
        } else if (pathname !== "/login") {
          router.replace("/login");
          return;
        }
        setResolved(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        // setup-status 也失败：容错放行
        setResolved(true);
      });

    return () => {
      cancelled = true;
    };
  }, [profile.isPending, profile.isSuccess, profile.data, profile.error, pathname, router]);

  if (profile.isPending || !resolved) {
    return <SplashScreen />;
  }

  return <>{children}</>;
}

/** 拉 setup-status —— 仅在 profile 401 时用于分流。 */
async function fetchSetupStatus(): Promise<AuthStatus> {
  const base = getBrowserApiBaseUrl();
  const res = await fetch(`${base}/api/setup-status`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`setup-status failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: AuthStatus } & AuthStatus;
  return (body.data ?? body) as AuthStatus;
}

function SplashScreen() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div className="drag-handle fixed top-0 right-0 left-0 h-[52px]" />

      <div className="flex flex-col items-center gap-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-foreground shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
            <span className="text-base font-semibold text-background">🤖</span>
          </div>
          <span className="text-[22px] font-semibold tracking-tight text-foreground">
            AnyBOT
          </span>
        </div>

        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在准备工作区…</span>
        </div>
      </div>
    </div>
  );
}
```

IMPORTANT：
- `profile.isPending` —— react-query v5 用 `isPending`（v4 是 `isLoading`）。本仓库用 `@tanstack/react-query@^5`，所以 `isPending` 正确。VERIFY：`atomWithQuery` 的 result 是否暴露 `isPending`/`isSuccess`/`isError`/`error`/`data`——它应镜像 react-query result。若字段名不同按实际调整。
- `fetchSetupStatus` 不走 apiClient（保持与旧代码一致的裸 fetch + 手动解包，且不触发 apiClient 副作用）。`{ data?: AuthStatus } & AuthStatus` 的解包与 `profile-client` 一致。
- 旧 `auth-guard.tsx` 里那段手写 `fetch('/api/setup-status')` 直接 `res.json() as AuthStatus`（没解包）——新代码用 `body.data ?? body` 修正了。
- 旧的 `queryClient.setQueryData(authStatusQueryKey, ...)` / `removeQueries` 逻辑去掉——新流程不需要预热那个 cache（`useAuthStatus` 若别处仍用会自己拉）。确认 `useAuthStatus` 的使用者（登录页 / setup 页）不依赖 AuthGuard 预热——它们各自 `useQuery` 会自己拉，不依赖预热。报告确认。
- `SplashScreen` 与 `Loader2` import 保持。

- [ ] **Step 2: 构建确认**

Run: `pnpm --filter @meshbot/web-agent build` — expect 成功。

- [ ] **Step 3: 登录成功后刷新 profile atom**

读 `apps/web-agent/src/rest/auth.ts` 的 `useLogin`。登录成功后需让 `profileQueryAtom` 重新拉（否则 AuthGuard 仍认为未登录）。`useLogin` 的 `onSuccess` 加 `queryClient.invalidateQueries({ queryKey: ["auth", "profile"] })`。

`useLogin` 改为：

```ts
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: login,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "profile"] });
    },
  });
}
```

（`useQueryClient` 从 `@tanstack/react-query` import——确认 auth.ts 已 import 或补上。`useRegister` 同样处理——注册成功也已登录，加同样的 `onSuccess`。）

登录页 `login/page.tsx` 现在 `await loginMutation.mutateAsync(values); router.push("/")` —— invalidate 后 `profileQueryAtom` 会重新拉，AuthGuard 在 `/` 上重新判定为已登录放行。这条链路无需改 `login/page.tsx`。

- [ ] **Step 4: 构建 + 提交**

Run: `pnpm --filter @meshbot/web-agent build` — expect 成功。

```bash
pnpm format
git add apps/web-agent/src/components/auth-guard.tsx apps/web-agent/src/rest/auth.ts
git commit -m "feat(web-agent): AuthGuard 重构为 profile 优先判定 + 登录后刷新 profile

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7：全量回归 + 手动冒烟

**Files:** 无（验证 Task）

- [ ] **Step 1: 全量回归**

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @meshbot/agent test
pnpm check
```

Expected：`typecheck` 全包无错；`build` 拓扑构建成功；`pnpm test` root Jest 全绿（含新 `auth-profile.e2e`）；agent vitest 全绿；6 围栏 0 finding。读完整输出，不被 tail / turbo 退出码掩盖失败。

- [ ] **Step 2: 手动冒烟（端到端验证根因修复）**

需要 server-agent + web-agent 都跑起来。两个终端：
```
pnpm dev:server-agent
pnpm dev:web-agent
```

验证三条：
1. **未初始化** → 打开 `http://localhost:3001`，应 SplashScreen 后进 `/setup`（profile 401 → setup-status needsSetup → /setup）。
2. **登录 token 保存** → 完成初始化/在 `/login` 登录，登录后浏览器 DevTools → Application → Local Storage 应有 `meshbot_access_token` 且值是 JWT（非 undefined）。这是问题 2 的直接验证。
3. **已登录引导** → 登录后刷新页面，应 SplashScreen 后直接进主页(profile 200，不跳登录页，不拉 setup-status —— Network 面板确认刷新时没有 `/api/setup-status` 请求)。

报告三条冒烟结果。若 1/2/3 任一不符，报告 BLOCKED + 现象。

- [ ] **Step 3: 提交（若冒烟暴露需修的小问题）**

若 Step 2 暴露需修的问题，修复后提交：
```bash
pnpm format
git add <修改的文件>
git commit -m "fix(web-agent): <具体修复>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
若冒烟全过，本 Task 无提交。

---

## 完成标准

- 登录后 `meshbot_access_token` 正确存入 localStorage（问题 2 修复）
- 登录态由 `GET /api/auth/profile` 判定：200 已登录、401 未登录（问题 1 修复）
- 用户信息经 Jotai `currentUserAtom` 全局可读
- AuthGuard：profile 优先；已登录不拉 setup-status；401 才拉 setup-status 分流 /login 或 /setup（问题 3 修复）
- `rest/session.ts` 冗余 unwrap 删除；`model-config.ts` / `auth.ts` 解包后自动正确
- `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm check` 全绿
