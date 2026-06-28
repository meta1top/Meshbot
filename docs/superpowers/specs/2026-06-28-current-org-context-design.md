# 当前组织上下文（SP-0：current-org context）设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-28
> 关联：**SP-A 网盘后端**（[[cloud-drive-backend]]）依赖本 spec 的 `token.orgId`；多组织 IM 隐患在此一并修。
> 上层大需求：企业级网盘。SP-0 是 SP-A 的**前置**。

## 1. 目标 / 范围

让"当前组织"成为可信、可切换、可被 server-main 各接口直接读到的上下文：**把当前 orgId 签进 cloudToken**，补**切换组织端点**，前端加**组织切换器**，并把 IM 从"猜 org"改成"读 token.orgId"。

**现状（已有，无需重建）**：
- `AppUser.activeOrgId`（server-main）已持久化"当前组织"，登录/注册/接受邀请时设置；`GET /auth/profile` 返回 `activeOrg` + `memberships`。
- server-agent 登录后从 `profile.activeOrg.id` 写 `CloudIdentity.{orgId, orgName, role}`。

**缺的三块（本 spec 补）**：
1. cloudToken 不含 orgId（现 `jwt.sign({userId, email})`）。
2. 无切换组织端点（activeOrgId 登录后改不了；接受第二个邀请也不切换）。
3. 前端无组织切换器（workspace-rail 的 org 菜单只链到 `/settings/org`）。

**范围**：
- ✅ server-main：`JwtMainPayload` 加 orgId；login/register/switch 签 token 时签入 activeOrgId；新增切换端点；IM 改读 `token.orgId`。
- ✅ server-agent：代理切换端点 + 切换后同步 `CloudIdentity`；登录链路不变（已写 orgId）。
- ✅ web-agent：组织切换器（workspace-rail 下拉）。
- ❌ **非目标**：强制登录时弹组织选择（采用"默认上次 activeOrg + 切换器随时切"）；网盘本身（SP-A）。

## 2. 设计

### ① token 带 orgId（核心）

- `JwtMainPayload` 由 `{userId, email}` → `{userId, email, orgId: string | null}`（`jwt.strategy.ts`，`validate()` 透传）。
- 所有签 token 处签入当前 `activeOrgId`：
  - `auth.controller.ts` login（行 ~72）/ register（行 ~60）：`jwt.sign({ userId, email, orgId: user.activeOrgId ?? null })`。
  - register 时 activeOrgId 多为 null（还没建/加组织）→ `orgId: null`，由 setup-status `needs-org` 引导；建/加组织后**重签**（见 ③）。
- server-main 各接口直接 `@CurrentUser().orgId`；为 null 时按"未选组织"处理（drive/IM 接口抛对应错误，正常流程下 needs-org 已拦住）。

### ② 切换组织端点

- server-main `POST /api/orgs/switch { orgId }`（JwtAuthGuard）：
  1. 校验 `membership.isMember(orgId, userId)`，否则 `ORG_FORBIDDEN`。
  2. `OrgService.switchActiveOrgInTx(userId, orgId)` 更新 `AppUser.activeOrgId`（单表 update，但与读成员同事务，命名 `*InTx`）。
  3. **重签** token：`jwt.sign({ userId, email, orgId })`。
  4. 返回 `{ access_token, org: { id, name, role } }`（access_token = 新 cloudToken）。
- server-agent 代理 `POST /api/orgs/switch`：转发云端 → 拿新 cloudToken → `CloudIdentityService.upsert`（更新 `cloudToken, orgId, orgName, role`）→ 返回 `{ org }`。**前端的本地 access_token 不变**——server-agent 签的本地 JWT 是 `{sub: cloudUserId, email}`、不含 org；org 全在 server-agent 持有的 cloudToken 里。前端只需刷新 profile。多账号：只更新当前请求账号（token 的 cloudUserId）对应的 CloudIdentity。

### ③ 登录 / 注册落实当前组织

- **登录**：返回结构不变（`{ access_token, ... }`）；token 现含 `orgId = activeOrgId`。前端 memberships/activeOrg 仍从 `GET /auth/profile` 拿（已返回），**不改登录返回结构**。
- **注册-创建组织**（`OrgService.persistNewOrg` 已设 activeOrgId）/ **注册-加入组织**（`acceptInvitation` 设 activeOrgId）：server-main 在响应里**重签含新 orgId 的 cloudToken**；server-agent 代理处更新 `CloudIdentity.{cloudToken, orgId, ...}`。前端本地 access_token 不变，invalidate profile/authStatus（setup-status 从 `needs-org` → `needs-model`/`ready`）。

### ④ 前端组织切换器

- `workspace-rail.tsx` 的 org 菜单项：从"单链接 `/settings/org`"改为**下拉**列出 `profile.memberships`（当前 activeOrg 高亮 + 勾选），底部保留"管理组织 → /settings/org"。
- 选某 org → `POST /api/orgs/switch` → 后端更新该账号 `CloudIdentity.{cloudToken, orgId}` → invalidate `profileQueryKey` + `authStatusQueryKey` + 所有 org 相关 query → UI 刷新到新组织上下文（本地 access_token 不变）。
- 切换中态 + 失败回退（保持原组织 + toast）。

### ⑤ IM 迁移（修多组织隐患）

- `im.controller.ts`：所有 `await this.resolveOrgId(user.userId)` → 直接 `user.orgId`（`@CurrentUser().orgId`）；删除私有 `resolveOrgId` 方法 + 其对 MembershipService 的依赖（若仅此一处用）。
- `user.orgId` 为 null（未选组织）时 IM 接口抛 `ORG_REQUIRED`（正常流程 needs-org 已拦）。
- IM 既有 e2e 改为签发含 orgId 的测试 token。

## 3. 数据流（切换组织）

```
前端组织切换器 选 orgB
  │ POST /api/orgs/switch { orgId: B }   （本地 JWT）
  ▼
server-agent CloudOrgController.switch
  │ 代理云端 POST /api/orgs/switch（带当前账号 cloudToken）
  ▼
server-main：isMember(B,user)? → activeOrgId=B → 重签 cloudToken{orgId:B} → { access_token, org }
  ▼
server-agent：CloudIdentity.upsert(cloudToken'=新, orgId=B, orgName, role) → 返回
  ▼
前端：invalidate profile/authStatus/org queries → 刷新（本地 access_token 不变）
```

## 4. 迁移注意

- **旧 token 失效**：JWT 结构加 orgId 后，**旧 cloudToken（无 orgId）解出 `orgId: undefined`**——drive/IM 接口取不到 org 会拦。部署后已登录用户需**重新登录**换新 token（或宽限：`orgId` 缺失时回退 `resolveOrgId` 一次性兜底，过渡期后移除——v1 采用直接重登，简单）。在 release note 标注。
- `activeOrgId` 为 null（注册未建组织）时 token `orgId: null`，靠 setup-status `needs-org` 引导，不进 drive/IM。

## 5. 测试

- **server-main e2e**：login/register 后 token 解出含 orgId；`POST /orgs/switch` 非成员→`ORG_FORBIDDEN`、成员→activeOrgId 更新 + 新 token orgId 正确；IM 接口用 `token.orgId`（建频道/列会话归属正确组织，跨组织隔离）。
- **server-main 单测**：`OrgService.switchActiveOrgInTx`（成员校验 + 更新）。
- **server-agent 单测**：CloudOrg 切换代理 + CloudIdentity 同步（cloudToken + orgId 更新）；多账号只动当前账号。
- **web-agent**：组织切换器组件（列 memberships、当前高亮、切换调用、失败回退）。
- 围栏：`switchActiveOrgInTx` 命名 + `@Transactional`；check:error-code 登记 `ORG_FORBIDDEN`/`ORG_REQUIRED`（若新增）。
- **无 DDL**（activeOrgId 已存在，无新表/新列）。

## 6. 涉及文件

- server-main：`auth/jwt.strategy.ts`（JwtMainPayload + validate）、`rest/auth.controller.ts`（login/register 签 orgId）、`rest/org.controller.ts`（switch 端点 + register-org/accept 重签）、`rest/im.controller.ts`（resolveOrgId → token.orgId）。
- libs/main：`services/org.service.ts`（`switchActiveOrgInTx`）、`services/membership.service.ts`（isMember 复用）。
- libs/types-main：`auth.ts` / `org.ts`（switch DTO + 登录返回 schema 若动）。
- server-agent：`controllers/cloud-org.controller.ts`（switch 代理）、`services/cloud-auth.service.ts` 或新增 `cloud-org.service.ts`（切换 + CloudIdentity 同步）。
- web-agent：`components/shell/workspace-rail.tsx`（org 下拉切换器）、`rest/org.ts`（switchOrg 调用）、登录/注册 token 落地（`useLogin`/`useRegister`/`useCreateOrg`/`useJoinOrg` 换 token 后刷新）。
- 错误码：`ORG_FORBIDDEN` / `ORG_REQUIRED`（defineErrorCode，主域）。

## 7. 后续

SP-0 合并后 → **SP-A 网盘后端**（token.orgId 已就绪）→ SP-B/C/D。
