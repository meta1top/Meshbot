# 网盘对外公开分享（SP-D：cloud-drive public share）设计

> 状态：已通过 brainstorm（4 决策已定），待评审 → writing-plans
> 日期：2026-06-29
> 关联：SP-A 网盘后端（已合并 main，`cloud_node`/`cloud_node_grant` + `CloudDriveService` + `drive-acl.ts` + Minio presigned）、SP-B agent 工具（`DRIVE_PORT` + 5 @Tool + HITL）、SP-C 网盘 UI（web-agent `app/(shell)/drive` + `rest/drive.ts`）。
> 上层大需求：企业级网盘。SP-0/A/B/C 已合并 main（`0b84666`）；SP-D 是**最后一块**——让网盘文件能生成公开短链，未登录的人通过链接访问。

## 1. 目标 / 范围

让网盘里的**单个文件**能生成**公开短链**，没有 meshbot 账号的人通过链接预览/下载；agent 也能创建公开链接（走 HITL）和下载别人的公开链接。

**SP-D 边界**：
- ✅ 新表 `cloud_share_link`（云端轨 Postgres）+ `CloudShareLinkService`。
- ✅ 鉴权端点（仅 owner）：创建 / 列出 / 撤销公开链接。
- ✅ 匿名端点（`@Public`）：取文件元信息 / 校验密码后拿 presigned 下载 URL。
- ✅ web-agent：文件行「公开链接」菜单 + `DriveShareLinkModal`（创建/管理/复制短链）。
- ✅ web-main：`app/share/[token]` 匿名公开页（简版内联预览 + 下载）。
- ✅ agent 工具：`drive_create_share`（HITL）+ `drive_fetch_share`（下载公开链接到 workspace）。
- ❌ **非目标**：文件夹公开分享（仅单文件）、下载次数限制、公开链接的访问统计/审计面板、自定义短码、动态水印、付费下载。

**决策汇总**（brainstorm 已定）：
1. **粒度**：仅单文件（`type="file"`），不做文件夹目录浏览。
2. **访问控制**：可撤销（默认）+ 可选过期时间 + 可选密码保护；**不做**下载次数上限。
3. **agent 角色**：创建（走 HITL 确认）+ 下载（消费外部公开链接）都要。
4. **匿名页预览**：简版内联——图片 `<img>` / PDF `<iframe>` 直接内联，其它类型显示文件信息 + 下载按钮。

**前置依赖**：SP-A（已合并）+ **Minio CORS 允许 web-main origin**（匿名页 img/iframe 直连 presigned，与 SP-C 的 web-agent origin 同理，运维配置）。

## 2. 架构

```
[访客无账号] → web-main app/share/[token]
                  │  GET /api/share/:token            (元信息, @Public)
                  │  POST /api/share/:token/download   (校验密码 → presigned, @Public)
                  ▼
              server-main DriveShareController(@Public 子集)
                  │  CloudShareLinkService.resolve(token, password)
                  │  校验 revokedAt/expiresAt/passwordHash → 绕 ACL
                  ▼  assets.getSignedUrl(node.assetKey, ttl)
              访客 <img>/<iframe>/下载 直连 Minio presigned

[owner 用户] → web-agent DriveShareLinkModal
                  │  POST /api/drive/nodes/:id/share-links  (JWT, owner)
                  ▼  生成 token + 入库 → 返回 {token, url}

[agent] → drive_create_share (HITL) → server-agent → server-main 创建端点
        → drive_fetch_share → server-agent → server-main 匿名 download 端点 → fetch → workspace
```

**复用现有模式**：
- `@Public()` 装饰器（`apps/server-main/src/auth/public.decorator.ts`）跳过 `JwtAuthGuard`（先例：health/register/login/skills）。
- token 生成仿 `invitation.service.ts` 的 `randomBytes`；presigned 仿 `cloud-drive.service.ts` 的 `assets.getSignedUrl`。
- Repository 单一归属（`CloudShareLinkService` 独占 `@InjectRepository(CloudShareLink)`）；雪花 id 用 `repo.create()+save()`。
- agent 工具仿 SP-B：`DRIVE_PORT` 扩接口 + `@Tool`；`drive_create_share` 走 `ConfirmationService` HITL（同 `drive_share`）。

## 3. 数据模型（新表 `cloud_share_link`）

`libs/main/src/entities/cloud-share-link.entity.ts`（继承 `SnowflakeBaseEntity`）：

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | bigint(雪花) | 主键 |
| `token` | varchar 唯一索引 | 公开短码，`randomBytes(9).toString("base64url")`（12 位 url-safe） |
| `nodeId` | bigint | 指向 `cloud_node`（逻辑外键，仅 `type="file"`） |
| `orgId` | bigint | 冗余，便于按 org 查/清理 |
| `createdByUserId` | bigint | 创建者 |
| `passwordHash` | varchar nullable | bcrypt 哈希；null = 无密码 |
| `expiresAt` | timestamptz nullable | null = 永久 |
| `createdAt` | timestamptz | |
| `revokedAt` | timestamptz nullable | 软删；撤销 = 置当前时间 |

**有效性判定**：`revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now())`。

## 4. 后端端点

**鉴权端点**（全局 `JwtAuthGuard` 保护，**仅 owner**，校验 `node.ownerUserId === ctx.userId`，否则 `DRIVE_FORBIDDEN`）：
- `POST /api/drive/nodes/:id/share-links` body `{ expiresInDays?: number | null, password?: string }` → 校验 node 是 owner 自己的 file → 生成 token + 可选 bcrypt 密码 + 算 expiresAt → 入库 → 返回 `{ token, url }`（url = `<WEB_MAIN_BASE>/share/<token>`，base 从配置取）。
- `GET /api/drive/nodes/:id/share-links` → 列出该 node 未撤销的链接（token/url/expiresAt/requiresPassword/createdAt）供管理。
- `DELETE /api/drive/share-links/:linkId` → 校验 owner → 置 `revokedAt`。

**匿名端点**（`@Public`，无需登录）：
- `GET /api/share/:token` → resolve token；无效/撤销/过期 → 410（`DRIVE_SHARE_NOT_FOUND` / `DRIVE_SHARE_EXPIRED`）；有效 → 返回 `{ name, sizeBytes, mime, requiresPassword: boolean }`（**不返回 url，不暴露 nodeId/orgId**）。
- `POST /api/share/:token/download` body `{ password?: string }` → resolve + 若 `passwordHash` 存在则 bcrypt 校验（错→`DRIVE_SHARE_PASSWORD_INVALID`）→ **绕过 ACL** 直接 `assets.getSignedUrl(node.assetKey, ttl)` → 返回 `{ url, name, mime }`。

## 5. presigned 匿名绕 ACL（关键安全点）

匿名端点**不能**走 `CloudDriveService.getDownloadUrl`（它先 `requirePermission(ctx, node, "viewer")`，匿名无 ctx 会拒）。`CloudShareLinkService` 校验 token+密码+过期通过后，**token 本身即授权**，直接调底层 `assets.getSignedUrl(node.assetKey, DRIVE_DOWNLOAD_TTL)`。presigned URL 自带凭证且短期（1h），访客直连 Minio。撤销/过期后已发出的 presigned 仍可能在 TTL 内有效（可接受，TTL 短）。

## 6. web-agent 创建 UI

- 文件行 DropdownMenu 加「公开链接」项（**仅 owner**，与「共享」并列）→ 打开 `DriveShareLinkModal({ nodeId })`。
- `DriveShareLinkModal`（`components/drive/drive-share-link-modal.tsx`）：
  - 列出已有链接（短链 URL + 复制按钮 + 过期/是否加密标识 + 撤销按钮）。
  - 「新建链接」：过期下拉（7 天 / 30 天 / 永久）+ 可选密码输入 → 创建 → 新链接出现在列表，自动复制/高亮。
  - Rules-of-Hooks 合规（hooks 顶层，`if(!open) return null` 之前）。
- `rest/drive.ts` 扩：`createShareLink(nodeId, {expiresInDays?, password?})` / `listShareLinks(nodeId)` / `revokeShareLink(linkId)` + hooks（queryKey `["drive","share-links",nodeId]`，建/撤销后 invalidate）。

## 7. web-main 匿名公开页

- `apps/web-main/src/app/share/[token]/page.tsx`（`@Public`，无鉴权拦截——web-main 当前无 middleware）：
  - 拉 `GET /api/share/:token`：失效 → 友好提示页（「链接已失效或不存在」）。
  - 有效 → 显示文件名 + 大小 + 类型图标。
  - `requiresPassword` → 密码输入框 → 提交触发 download 端点。
  - 拿到 `{url, mime}`：图片 → `<img src=url>`；PDF → `<iframe src=url>`；其它 → 大「下载」按钮（`a.href=url download`）。
  - web-main rest 层（仿现有 apiClient，但匿名调用，无 token）+ 简单页面用 `@meshbot/design` 组件。
- 路由 `app/share/[token]`：web-main 当前是 App Router 极简骨架，新增此动态路由不冲突。

## 8. agent 工具（SP-B 扩展）

`DRIVE_PORT` 接口加两方法；types-agent 加两 schema；libs/agent 加两 `@Tool`；server-agent `DriveToolService` 实现。

| 工具 | input | 行为 | HITL |
|------|-------|------|------|
| `drive_create_share` | `{ nodeId: string, expiresInDays?: number \| null, password?: string }` | 为文件创建公开链接；返回 `{ token, url }` | **是** |
| `drive_fetch_share` | `{ token: string, destPath: string, password?: string }` | 下载公开链接内容到 workspace 相对路径；返回写入路径 | 否 |

- `drive_create_share`：**对外暴露文件比内部 share 更敏感** → `ConfirmationService.waitForDecision` 挂起 + 前端确认卡（复用 drive_share 卡模式，显示「为 <文件名> 创建公开链接，过期 <…>，<带/不带>密码」）；确认 → 调创建端点。取消/超时 → 不创建。
- `drive_fetch_share`：调 server-main 匿名 download 端点（token + password）→ 拿 presigned → 裸 fetch 字节 → `getWorkspaceDir()` + 越界校验写文件 → 返回相对路径。失败 → `DRIVE_SHARE_FETCH_FAILED`。

## 9. 错误码 / DDL

- **MainErrorCode**（server-main，从 2019 起）：`DRIVE_SHARE_NOT_FOUND`(2019，含撤销/不存在)、`DRIVE_SHARE_EXPIRED`(2020)、`DRIVE_SHARE_PASSWORD_INVALID`(2021)。
- **AgentErrorCode**（agent 域）：`DRIVE_SHARE_FETCH_FAILED`（工具层 catch 返回 `Error: <msg>` 给 LLM）。
- **DDL**：`apps/server-main/migrations/202607010000-cloud-drive-share.sql`——`CREATE TABLE IF NOT EXISTS cloud_share_link`（snake_case 列、逻辑外键、`token` 唯一索引、`node_id` 普通索引），DBA 手动执行，文件不可变。

## 10. 安全 / 边界

- **匿名端点不泄露内部 id**：`GET /api/share/:token` 只回 name/size/mime/requiresPassword，不回 nodeId/orgId/owner。
- **owner-only 创建**：非 owner 创建/撤销 → `DRIVE_FORBIDDEN`。
- **密码**：bcrypt 哈希存储（复用 auth 现有 hash util），明文不落库。
- **撤销即时**：`revokedAt` 后 resolve 立即失效；已发 presigned 在 TTL（1h）内可能仍有效（可接受）。
- **限流防暴力**：匿名端点已被全局 `ProxyThrottlerGuard` 覆盖（防密码暴力试探）。v1 错误码分开返回（`DRIVE_SHARE_NOT_FOUND` vs `DRIVE_SHARE_PASSWORD_INVALID`）便于前端体验，接受轻微信息泄露（链接是否存在），由限流兜底。
- **节点删除联动**：node 删除后其 share_link 自然失效（resolve 时 join 不到 ready node → NOT_FOUND）；不强制级联删 link 行。

## 11. 测试

- **server-main 单测/e2e**（jest）：创建（owner 校验、token 唯一、expiresAt 计算、bcrypt）、resolve（有效/撤销/过期/密码对错）、匿名 download（绕 ACL 拿 presigned）、非 owner 拒。
- **libs/agent 工具单测**（vitest）：两 @Tool execute 透传 port + schema 校验；`drive_create_share` HITL 路径。
- **server-agent 单测**（jest）：`DriveToolService.createShare`（HITL 确认/取消）、`fetchShare`（调匿名端点→fetch→写 workspace，越界 destPath 拒）。
- **前端**：web-agent `DriveShareLinkModal`（Rules-of-Hooks）；web-main 匿名页 typecheck（无完善自动测）。
- **围栏**：check:error-code（新码登记）、check:repo（CloudShareLink 单一归属）、check:pk（继承 SnowflakeBaseEntity）。

## 12. 涉及文件（预估）

- **libs/main**：`entities/cloud-share-link.entity.ts`、`services/cloud-share-link.service.ts`、`errors/main.error-codes.ts`（+3 码）。
- **server-main**：`drive-share.controller.ts`（鉴权 + @Public 端点）、`migrations/202607010000-cloud-drive-share.sql`、配置 `WEB_MAIN_BASE`（短链 base）。
- **libs/types-main / types-agent**：share schema。
- **libs/agent**：`tools/drive.port.ts`（+2 方法）、`tools/builtins/drive-create-share.tool.ts` + `drive-fetch-share.tool.ts`、agent.module 注册。
- **server-agent**：`services/drive-tool.service.ts`（+createShare/fetchShare）、`drive-gateway.service.ts`（+share-link 转发）、AgentErrorCode（+1）。
- **web-agent**：`rest/drive.ts`（+3 fn/hooks）、`components/drive/drive-share-link-modal.tsx`、`drive-file-list.tsx`（菜单项）、`components/session/` 确认卡特判（drive_create_share）、i18n。
- **web-main**：`app/share/[token]/page.tsx`、rest 匿名调用、i18n。

## 13. 任务拆分（预估，writing-plans 细化）

1. **后端数据模型**：`CloudShareLink` entity + DDL + `CloudShareLinkService`（create/resolve/list/revoke 纯逻辑 + 错误码）。
2. **后端鉴权端点**：`POST/GET/DELETE` share-links（owner 校验 + token 生成 + bcrypt + url 组装）。
3. **后端匿名端点**：`@Public` `GET /api/share/:token` + `POST .../download`（resolve + 绕 ACL presigned）。
4. **web-agent 创建 UI**：rest 扩 + `DriveShareLinkModal` + 文件行菜单。
5. **web-main 匿名页**：`app/share/[token]` + 匿名 rest + 简版内联预览。
6. **agent 工具**：`DRIVE_PORT` 扩 + 2 schema + 2 @Tool + `DriveToolService` 实现 + `drive_create_share` HITL 确认卡。
7. **集成验证**：typecheck + 围栏 + 单测 + 手动。

## 14. 后续

SP-D 完成后，企业网盘大需求（SP-0/A/B/C/D）全部落地。后续优化（非本 spec）：文件夹公开分享、访问统计、大文件流式、自定义短码。
