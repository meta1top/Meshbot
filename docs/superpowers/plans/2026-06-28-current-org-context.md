# 当前组织上下文（SP-0）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 orgId 签进 cloudToken，补切换组织端点 + 前端切换器，并把 IM 从"查 activeOrgId 猜组织"改成"读 token.orgId"。

**Architecture:** server-main 的 `JwtMainPayload` 加 `orgId`，login/register/switch 签 token 时签入 `activeOrgId`；新增 `POST /auth/switch-org`（校验成员 → 更新 activeOrgId → 重签）；server-agent 代理该端点并同步 `CloudIdentity`（本地 access_token 不变）；前端 workspace-rail 加组织切换器。复用已有 `AppUser.activeOrgId`，无新表/DDL。

**Tech Stack:** NestJS / TypeORM / Postgres（server-main）/ SQLite（server-agent CloudIdentity）/ Next.js + Jotai + react-query（web-agent）。

## Global Constraints

- 复用已有 `MainErrorCode.ORG_FORBIDDEN` / `ORG_NOT_FOUND`，**不新增错误码**。
- `AppUser` 的写归属是 `UserService`（check:repo）；更新 `active_org_id` 必须经 UserService，不在 OrgController/AuthController 直接注入 AppUser repo。
- `switchActiveOrg` 是单表 update（app_user），**不需 `@Transactional`**，不用 `*InTx` 命名（check:naming 反向规则）。
- server-main JWT payload 改动后**旧 token（无 orgId）失效，用户需重登录**（已与用户确认，release note 标注）。
- 切换组织：**前端本地 access_token 不变**（server-agent 本地 JWT 是 `{sub, email}`，org 只在 cloudToken）；切换只更新 server-agent 的 `CloudIdentity.{cloudToken, orgId, orgName, role}` + 前端刷 profile。
- 改 DI（移除 im.controller 的 `users` 注入）后必须 **boot 验证 server-main**（真启动，typecheck/单测漏 DI 崩溃）。
- 公开方法中文 JSDoc；不在 `if` 前一行放注释；中文提交。

---

## Task 1: server-main token 带 orgId

**Files:**
- Modify: `apps/server-main/src/auth/jwt.strategy.ts`
- Modify: `apps/server-main/src/rest/auth.controller.ts`
- Test: `apps/server-main/test/e2e/auth-org.e2e.spec.ts`（新建）

**Interfaces:**
- Produces: `JwtMainPayload = { userId: string; email: string; orgId: string | null }`。
- Produces: `AuthController.signResponse(user)` 签入 `orgId: user.activeOrgId ?? null`。

- [ ] **Step 1: 改 JwtMainPayload + validate** — `jwt.strategy.ts`：

```typescript
export interface JwtMainPayload {
  userId: string;
  email: string;
  orgId: string | null;
}
```

`validate()` 改为：

```typescript
  validate(payload: JwtMainPayload): JwtMainPayload {
    return {
      userId: payload.userId,
      email: payload.email,
      orgId: payload.orgId ?? null,
    };
  }
```

- [ ] **Step 2: signResponse 签入 orgId** — `auth.controller.ts` 的 `signResponse`：

```typescript
  private signResponse(user: AppUser): AuthTokenResponse {
    const token = this.jwt.sign({
      userId: user.id,
      email: user.email,
      orgId: user.activeOrgId ?? null,
    });
    return {
      token,
      expiresIn: this.config.jwt.expires,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  }
```

- [ ] **Step 3: 写 e2e 测试** — `apps/server-main/test/e2e/auth-org.e2e.spec.ts`：参照现有 e2e（如 `session.e2e.spec.ts` 不是 server-main；用 server-main 既有 e2e 如 `apps/server-main/test/e2e/*.e2e.spec.ts` 的 bootstrap 模式——先 `rg -l "Test.createTestingModule" apps/server-main/test` 找模板）。断言：register 后解 token 含 `orgId: null`；建组织后重新登录，token `orgId` = 该组织 id。最小用例：

```typescript
it("register 后 token 含 orgId=null（未建组织）", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/auth/register")
    .send({ email: "t1@x.com", password: "pw123456", displayName: "T1" })
    .expect(201);
  const decoded = jwtService.decode(res.body.token) as { orgId: string | null };
  expect(decoded.orgId).toBeNull();
});
```

- [ ] **Step 4: 跑测试** — `pnpm test -- auth-org.e2e`，Expected: PASS。
- [ ] **Step 5: commit** — `git add -A && git commit -m "feat(server-main): JWT payload 加 orgId，登录/注册签入 activeOrgId"`

---

## Task 2: 切换组织端点 `POST /auth/switch-org`

**Files:**
- Modify: `libs/main/src/services/user.service.ts`（加 `setActiveOrg`）
- Modify: `apps/server-main/src/rest/auth.controller.ts`（加 switchOrg 端点）
- Create: `libs/types-main/src/`（SwitchOrgDto，并入既有 org/auth schema 文件——先 `rg -l "CreateOrgDto" libs/types-main/src` 找落点）
- Test: `apps/server-main/test/e2e/auth-org.e2e.spec.ts`（追加）

**Interfaces:**
- Consumes: `JwtMainPayload.orgId`（Task 1）、`AuthController.signResponse`（Task 1）、`MembershipService.assertMember(orgId, userId)`（已存在，非成员抛 ORG_FORBIDDEN）、`UserService.findById`（已存在）。
- Produces: `UserService.setActiveOrg(userId: string, orgId: string): Promise<void>`（单表 update app_user.active_org_id）。
- Produces: `POST /api/auth/switch-org { orgId }` → `AuthTokenResponse`（新 token 含 orgId）。

> **路由说明**：spec 草案写 `/api/orgs/switch`，实现改放 `AuthController` 的 `/api/auth/switch-org`——因为切换的本质是"换 org 重签 token"，复用 `signResponse` + 已注入的 jwt/memberships/users，避免 OrgController 再注入 JwtService。server-agent 对前端仍暴露 `/api/orgs/switch`（Task 4 网关），互不影响。

- [ ] **Step 1: UserService.setActiveOrg** — `user.service.ts` 加方法（AppUser 写归属在此）：

```typescript
  /** 设置用户当前活跃组织（单表 update app_user.active_org_id）。调用方负责先校验成员资格。 */
  async setActiveOrg(userId: string, orgId: string): Promise<void> {
    await this.userRepo.update({ id: userId }, { activeOrgId: orgId });
  }
```

（`userRepo` 字段名以文件实际为准——先 Read user.service.ts 确认 `@InjectRepository(AppUser)` 的字段名。）

- [ ] **Step 2: SwitchOrgDto** — 在 libs/types-main 既有 org schema 文件加：

```typescript
export const SwitchOrgSchema = z.object({ orgId: z.string().min(1) });
export class SwitchOrgDto extends createZodDto(SwitchOrgSchema) {}
```

（导出方式对齐文件里 `CreateOrgDto` 的写法。）

- [ ] **Step 3: AuthController.switchOrg 端点** — `auth.controller.ts`，注意 `switch-org` 不能是 `@Public`（需登录）：

```typescript
  /** 切换当前活跃组织：校验成员 → 更新 activeOrgId → 重签含新 orgId 的 token。 */
  @Post("switch-org")
  @HttpCode(200)
  async switchOrg(
    @CurrentUser() jwt: JwtMainPayload,
    @Body() dto: SwitchOrgDto,
  ): Promise<AuthTokenResponse> {
    await this.memberships.assertMember(dto.orgId, jwt.userId);
    await this.users.setActiveOrg(jwt.userId, dto.orgId);
    const user = await this.users.findById(jwt.userId);
    if (!user) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    return this.signResponse(user);
  }
```

（import `AppError` from `@meshbot/common`、`MainErrorCode` from `@meshbot/main`、`SwitchOrgDto` from `@meshbot/types-main`。）

- [ ] **Step 4: 写测试** — 追加到 `auth-org.e2e.spec.ts`：非成员 orgId → 403/ORG_FORBIDDEN；成员 → 200 + 新 token orgId 正确 + DB 的 active_org_id 更新。

```typescript
it("switch-org 非成员 → ORG_FORBIDDEN", async () => {
  await request(app.getHttpServer())
    .post("/api/auth/switch-org")
    .set("Authorization", `Bearer ${tokenOfUserA}`)
    .send({ orgId: orgOfUserB })
    .expect(403);
});

it("switch-org 成员 → 新 token orgId 更新", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/auth/switch-org")
    .set("Authorization", `Bearer ${tokenOfUserA}`)
    .send({ orgId: secondOrgOfUserA })
    .expect(200);
  const decoded = jwtService.decode(res.body.token) as { orgId: string };
  expect(decoded.orgId).toBe(secondOrgOfUserA);
});
```

- [ ] **Step 5: 跑测试** — `pnpm test -- auth-org.e2e`，Expected: PASS。
- [ ] **Step 6: commit** — `git add -A && git commit -m "feat(server-main): POST /auth/switch-org 切换活跃组织并重签 token"`

---

## Task 3: IM 改读 token.orgId（修多组织隐患）

**Files:**
- Modify: `apps/server-main/src/rest/im.controller.ts`
- Test: 既有 IM e2e（先 `rg -l "conversations" apps/server-main/test` 找；改 token 工厂为含 orgId）

**Interfaces:**
- Consumes: `JwtMainPayload.orgId`（Task 1）。
- 移除 `ImController.resolveOrgId` 私有方法 + `users: UserService` 注入（删后 `users` 不再被任何方法引用）。

- [ ] **Step 1: 加 requireOrg helper + 替换调用** — `im.controller.ts`：删除 `resolveOrgId`（行 187-195），替换为读 token 的 helper：

```typescript
  /** 取当前请求的活跃组织（token 签发时已验成员）；未选组织抛 ORG_NOT_FOUND。 */
  private requireOrg(user: JwtMainPayload): string {
    if (!user.orgId) {
      throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    }
    return user.orgId;
  }
```

把 5 处 `const orgId = await this.resolveOrgId(user.userId);`（行 62/72/102/132/183）改为 `const orgId = this.requireOrg(user);`（去掉 await）。

- [ ] **Step 2: 移除 users 注入** — `resolveOrgId` 删除后 `this.users` 不再被用（addMember/leave 用 conversation 返回的 orgId，不经 users）。从 constructor 删 `private readonly users: UserService,`，并删 `UserService` import（确认 `rg "this.users" apps/server-main/src/rest/im.controller.ts` 为空后再删）。

- [ ] **Step 3: typecheck** — `pnpm turbo typecheck --filter=@meshbot/server-main`，全绿（确认无悬空 UserService 引用）。

- [ ] **Step 4: 改 IM e2e token 工厂** — 既有 IM e2e 签发的测试 token 加 `orgId`（用户的活跃组织 id），否则 `requireOrg` 抛 ORG_NOT_FOUND。跑 `pnpm test -- <im e2e 文件名>`，Expected: PASS（与改前同样通过，证明等价）。

- [ ] **Step 5: boot 验证 server-main** — 真启动确认 DI 不崩（移除注入是 DI 改动）：

```bash
pnpm dev:server-main &
sleep 8
curl -s http://127.0.0.1:3200/api/health 2>/dev/null || echo "（无 health 则看日志有无 Nest 启动完成、无 UnknownDependenciesException）"
# 看启动日志：ImController 正常实例化、无 "Nest can't resolve dependencies"
kill %1
```

Expected: server-main 正常启动，无 DI 报错。

- [ ] **Step 6: commit** — `git add -A && git commit -m "refactor(server-main): IM 改读 token.orgId，移除 resolveOrgId 与 users 注入"`

---

## Task 4: server-agent 切换代理 + CloudIdentity 同步

**Files:**
- Modify: `apps/server-agent/src/services/cloud-auth.service.ts`（加 switchOrg）
- Modify: server-agent org controller（加 `POST /api/orgs/switch` 路由——先 `rg -l "@Controller.*orgs|CloudOrg" apps/server-agent/src` 找现有 org controller；无则在 auth controller 加）
- Test: `apps/server-agent/src/services/cloud-auth.service.spec.ts`（新建或追加）

**Interfaces:**
- Consumes: server-main `POST /api/auth/switch-org`（Task 2，返回 `{ token, expiresIn, user }`）。
- Consumes: `CloudClientService.post/get`（带 cloudToken）、`CloudIdentityService.upsert`、`AccountContextService.getOrThrow`。
- Produces: `CloudAuthService.switchOrg(orgId: string): Promise<LocalProfile>`（更新 CloudIdentity，返回新 profile；本地 access_token 不变）。

- [ ] **Step 1: CloudAuthService.switchOrg** — 复用 afterCloudAuth 的"拉 profile + upsert"模式，但**不重建 runtime、不重签本地 JWT**：

```typescript
  /**
   * 切换当前账号的活跃组织：代理云端 switch-org 拿新 cloudToken，
   * 重拉 profile 刷新组织镜像，更新 CloudIdentity。本地 access_token 不变
   * （本地 JWT 的 sub=cloudUserId 不随 org 改变），前端刷 profile 即可。
   */
  async switchOrg(orgId: string): Promise<LocalProfile> {
    const cloudUserId = this.account.getOrThrow();
    const id = await this.identity.get(cloudUserId);
    if (!id?.cloudToken) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    const auth = await this.cloud.post<CloudAuthData>(
      "/api/auth/switch-org",
      { orgId },
      id.cloudToken,
    );
    const profile = await this.cloud.get<CloudProfileData>(
      "/api/auth/profile",
      auth.token,
    );
    await this.identity.upsert({
      cloudUserId: auth.user.id,
      email: auth.user.email,
      displayName: auth.user.displayName,
      cloudToken: auth.token,
      cloudTokenExpiresAt: computeExpiresAt(auth.expiresIn),
      orgId: profile.activeOrg?.id ?? null,
      orgName: profile.activeOrg?.name ?? null,
      role: profile.activeOrg?.role ?? null,
    });
    return this.getProfile();
  }
```

（`CloudClientService.post(path, body, token?)` 第三参是 token——确认签名；`computeExpiresAt` 已是本文件模块函数，可直接调。）

- [ ] **Step 2: controller 路由** — 在 server-agent 暴露给前端的 org/auth controller 加：

```typescript
  /** 切换当前活跃组织（代理云端 + 同步本地镜像）。 */
  @Post("orgs/switch")
  @HttpCode(200)
  async switchOrg(@Body() dto: { orgId: string }): Promise<LocalProfile> {
    return this.cloudAuth.switchOrg(dto.orgId);
  }
```

（路由前缀按该 controller 现状；最终对前端为 `POST /api/orgs/switch`。DTO 用 server-agent 既有校验风格。）

- [ ] **Step 3: 单测** — `cloud-auth.service.spec.ts`：mock cloud（switch 返回新 token、profile 返回新 activeOrg）+ mock identity；断言 `upsert` 收到新 cloudToken + 新 orgId/orgName/role，返回的 profile.org 是新组织。参照仓库既有 `*.service.spec.ts`（如 `im-relay-client.service.spec.ts`）的 mock 风格。

- [ ] **Step 4: 跑测试** — `pnpm test -- cloud-auth.service`，Expected: PASS。

- [ ] **Step 5: boot 验证 server-agent** — `pnpm dev:server-agent` 启动确认 DI 不崩（新增端点/方法）；看日志无 UnknownDependenciesException。

- [ ] **Step 6: commit** — `git add -A && git commit -m "feat(server-agent): 切换组织代理端点 + CloudIdentity 同步"`

---

## Task 5: web-agent 组织切换器

**Files:**
- Modify: `apps/web-agent/src/components/shell/workspace-rail.tsx`（org 菜单 → 下拉切换器）
- Modify/Create: `apps/web-agent/src/rest/org.ts`（switchOrg 调用 + query invalidation）
- Modify: `apps/web-agent/src/components/setup/org-step.tsx` + `apps/web-agent/src/app/register/page.tsx`（建组织/加入后接 switchOrg）
- Test: typecheck + 手动

**Interfaces:**
- Consumes: server-agent `POST /api/orgs/switch`（Task 4）、`GET /api/auth/profile`（返回 `memberships` + `activeOrg`）。

- [ ] **Step 1: switchOrg rest** — `rest/org.ts` 加：

```typescript
/** 切换活跃组织：调 server-agent 代理，成功后失效 profile/authStatus/org 相关查询。 */
export async function switchOrg(orgId: string): Promise<void> {
  await apiClient.post("/api/orgs/switch", { orgId });
}
```

（apiClient 的 import 与既有 rest 文件一致。）

- [ ] **Step 2: workspace-rail 下拉切换器** — 把现有"链接到 /settings/org 的单 DropdownMenuItem"扩展为：列出 `profile.memberships`（每项可点切换、当前 `activeOrg` 高亮 + 勾选图标），底部保留"管理组织 → /settings/org"。点某项：

```tsx
const qc = useQueryClient();
const onSwitch = async (orgId: string) => {
  if (orgId === currentOrgId) return;
  await switchOrg(orgId);
  await qc.invalidateQueries({ queryKey: profileQueryKey });
  await qc.invalidateQueries({ queryKey: authStatusQueryKey });
  // org 相关列表（成员、会话侧栏等）一并失效
  await qc.invalidateQueries({ queryKey: ["org"] });
  await qc.invalidateQueries({ queryKey: ["members"] });
};
```

memberships/当前组织从既有 `currentUserAtom`（读 profile）拿——先 Read workspace-rail.tsx 确认现有 profile/org 读取方式与 `profileQueryKey`/`authStatusQueryKey` 的实际常量名。切换中态（pending）+ 失败 toast/回退（保持原组织）。

- [ ] **Step 3: 注册-创建/加入后接 switchOrg（补 token 漏洞）** — 注册向导 OrgStep（`apps/web-agent/src/components/setup/org-step.tsx` + `register/page.tsx`）：`useCreateOrg` / `useJoinOrg` 成功拿到新 `orgId` 后，**立即 `await switchOrg(orgId)`** 再推进/跳转——否则 cloudToken 仍 `orgId=null`，进主页后网盘/IM 报 ORG_NOT_FOUND。create 端点返回 `OrgSummary{ id }`、accept 返回 `{ orgId }`，取其 id 传入。switchOrg 后照常 invalidate profile/authStatus。

```tsx
// onCreate 成功后：
const org = await createOrg(name);      // { id, name, role }
await switchOrg(org.id);                // 重签 cloudToken 含 orgId
// onJoin 成功后：
const { orgId } = await joinOrg(token);
await switchOrg(orgId);
```

- [ ] **Step 4: typecheck + biome** — `pnpm turbo typecheck --filter=@meshbot/web-agent` 全绿；`npx biome check --write` 改动文件。

- [ ] **Step 5: commit** — `git add -A && git commit -m "feat(web-agent): 组织切换器 + 注册建组织/加入后切换重签"`

---

## Task 6: 集成验证

- [ ] **Step 1: 全包 typecheck** — `pnpm typecheck`，全绿。
- [ ] **Step 2: 全量 jest** — `pnpm test`：除既有基线（session.e2e、use-global-events.spec）外零新增失败；新增的 auth-org e2e + cloud-auth.service 测试通过；IM e2e 仍通过。
- [ ] **Step 3: 静态围栏** — `pnpm check`，exit 0（check:repo 确认 AppUser 仍唯一归属 UserService；check:naming 确认无违规；check:error-code 无新增码也无破坏）。
- [ ] **Step 4: 手动端到端（必做）** — `pnpm dev:server-main` + `pnpm dev:server-agent` + `pnpm dev:web-agent`：
  - 多组织用户登录 → workspace-rail 出现组织下拉、当前组织高亮。
  - 切换组织 → IM 会话侧栏/成员切到新组织内容；profile 显示新组织。
  - 旧 token（如有缓存）→ 重登录后正常（验证迁移说明）。
  - 注册-创建组织 / 注册-加入组织 → 进入后当前组织正确（token 含 orgId、setup-status → ready）。

---

## Self-Review（已核对）

- **Spec 覆盖**：① token 带 orgId（Task 1）；② 切换端点（Task 2 server-main + Task 4 server-agent 代理）；③ 登录/注册落实（Task 1 signResponse 覆盖 login/register；注册建组织/加入后下次签 token 自动含 orgId——`persistNewOrg`/`acceptInvitation` 已设 activeOrgId，前端建组织/加入后**重新登录或刷 profile 时**经 server-agent 重拉 profile 更新镜像，token 侧由下次签发覆盖）；④ 前端切换器（Task 5）；⑤ IM 迁移（Task 3）。
- **注册重签澄清**：spec §3 提"注册建组织/加入后重签 token"。关键漏洞：登录时还没组织 → cloudToken `orgId=null`；建组织/加入只设 `activeOrgId`、**不会重签 cloudToken**，token 仍 `orgId=null`，网盘/IM 会 ORG_NOT_FOUND。解法：**前端在注册-创建组织 / 加入组织成功后，立即调 `switchOrg(新 orgId)`**（复用 Task 4 切换端点：重签含 orgId 的 cloudToken + 同步 CloudIdentity）。收敛进 Task 5 Step 3。
- **类型一致**：`JwtMainPayload.orgId`（Task 1）→ Task 2 switchOrg 读、Task 3 requireOrg 读，一致；`UserService.setActiveOrg(userId, orgId)`（Task 2）签名前后一致；`CloudAuthService.switchOrg(orgId): Promise<LocalProfile>`（Task 4）与 controller 调用一致。
- **占位符**：无 TBD；多处"先 rg/Read 确认实际字段名/落点"是真实的代码核对指令（字段名以文件为准），非占位。
- **错误码**：全程复用 `ORG_FORBIDDEN`/`ORG_NOT_FOUND`，无新增（check:error-code 不受影响）。
- **DI 风险**：Task 3 移除注入、Task 4 新增方法/端点，各自 boot 验证。
