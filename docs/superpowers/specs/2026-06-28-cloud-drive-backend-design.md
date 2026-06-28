# 企业网盘后端（SP-A：cloud-drive backend）设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-28
> 关联：[[skill-marketplace-sp3]]（复用 Minio + server-main 模式）、[[artifact-preview]]（产物预览将接入网盘）
> 上层大需求：企业级网盘（Google Drive 式），拆为 SP-A 后端 / SP-B agent 工具 / SP-C 网盘 UI / SP-D 对外分享。**本 spec 只覆盖 SP-A。**

## 1. 目标 / 范围

构建企业级网盘的**后端地基**：云端文件/文件夹存储（Minio）+ 元数据（server-main Postgres）+ Google Drive 式 ACL 权限（viewer/editor，可共享给组织或指定成员）+ 组织配额 + presigned 直传/直下 + server-agent 网关代理。

**SP-A 边界**：
- ✅ server-main：`cloud_node` / `cloud_node_grant` 表 + DDL + CRUD + ACL 鉴权 + 配额 + presigned 上传/下载接口。
- ✅ server-agent：网盘网关（本地 JWT 鉴权 → 带 cloudToken 转发 server-main，纯 JSON）。
- ✅ libs/assets：加 `presignedPutObject`。
- ✅ e2e 测试（server-main 接口 + ACL + 配额）。
- ❌ **非目标**：网盘 UI（SP-C）、agent 工具（SP-B）、对外公开分享/短链（SP-D）。这些是后续子项目。

**前置依赖**：**SP-0「当前组织」**——登录/注册/切组织时把当前 orgId 签入 cloudToken，并给 server-main `JwtMainPayload` 加 `orgId`。SP-A 假设 token 已含正确的当前 orgId，故 SP-0 必须先落地。

## 2. 架构

**两轨定位**：网盘是**云端轨**能力——文件存 Minio、元数据存 server-main Postgres、多租户多端访问。本地轨（server-agent）只做**网关代理**，不持有网盘数据、不直连 Minio 写元数据。

**访问链路**（复用 [[skill-marketplace-sp3]] 的 server-agent→server-main 链路）：
```
web-agent UI / agent 工具
   │  apiClient（本地 JWT）
   ▼
server-agent 网盘网关（DriveController）
   │  CloudClientService（带当前账号 CloudIdentity.cloudToken，token 已含当前 orgId）
   ▼
server-main /api/drive/*（JwtAuthGuard → token.{userId, orgId} → 判 ACL）
   │
   ├─ 元数据 → Postgres（cloud_node / cloud_node_grant）
   └─ 文件字节 → Minio（presigned PUT/GET，客户端直连，不经后端中转）
```

**presigned 直传/直下**：文件字节**不经 server-agent / server-main 中转**，客户端拿 presigned URL 直连 Minio。后端只经手元数据 + 鉴权 + 签 URL。
- 前提（部署约束，写入运维文档）：**Minio 公网可达 + CORS 允许 web-agent origin**。
- server-agent 网关因此是**纯 JSON 转发**（list/folder/upload-request/complete/rename/move/delete/grants/download-url 全是 JSON），无 multipart/stream 代理。

## 3. 数据模型

### `cloud_node`（文件/文件夹统一一张表）

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | varchar(20) | 雪花 id（SnowflakeBaseEntity） |
| `org_id` | varchar(20) | 归属组织（配额 + org 共享判定） |
| `owner_user_id` | varchar(20) | 创建者（恒为全权） |
| `parent_id` | varchar(20) NULL | 父文件夹；null = 用户根 |
| `type` | varchar(8) | `file` \| `folder` |
| `name` | varchar(256) | 显示名（同父下同名由应用层去重/拒绝） |
| `asset_key` | varchar(256) NULL | 文件指向 Minio 对象 key；文件夹为 null |
| `size_bytes` | bigint | 文件字节数；文件夹为 0 |
| `mime` | varchar(128) NULL | 文件 MIME |
| `checksum` | varchar(64) NULL | sha256（complete 时由客户端上报，可选） |
| `status` | varchar(12) | `uploading` \| `ready`（文件夹直接 ready） |
| `created_at` / `updated_at` | timestamptz | |

- 单表 + `parent_id` 自引用 = 目录树。逻辑外键（无 DB 级约束）。
- `asset_key` 格式：`drive/<org_id>/<node_id>`（org 隔离 + 全局唯一）。

### `cloud_node_grant`（ACL）

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | varchar(20) | 雪花 id |
| `node_id` | varchar(20) | 被授权节点 |
| `grantee_type` | varchar(8) | `org` \| `user` |
| `grantee_id` | varchar(20) | org_id 或 user_id |
| `permission` | varchar(8) | `viewer` \| `editor` |
| `created_at` | timestamptz | |

- 无 grant = 私有（仅 owner）。`(node_id, grantee_type, grantee_id)` 唯一（同一被授权方一条，重设覆盖 permission）。

## 4. 权限模型（Google Drive 式继承）

**permission 级别**：`owner`（恒为创建者，全权 + 改共享设置）> `editor`（上传/改名/移动/删/建子目录）> `viewer`（看/下载）。

**判定算法** `resolvePermission(user, node) → 'owner'|'editor'|'viewer'|null`：
1. `node.owner_user_id === user.id` → `owner`。
2. 否则**沿 parent 链**（node → ancestors → 根）收集所有 grant；对每条 grant，命中条件取其 permission：
   - `grantee_type='user'` 且 `grantee_id === user.id`，或
   - `grantee_type='org'` 且 `grantee_id === 当前 org`。
3. 取命中 grant 的**最高** permission（editor > viewer）；无命中 → `null`（无权访问）。

> **当前 org 来源**（多组织，token 绑定组织）：用户属多组织，登录/切组织时选定的**当前组织已签入 cloudToken**（见前置 **SP-0：当前组织**）。server-main 的 `JwtMainPayload` 含 `{userId, email, orgId}`，drive 接口直接从 `@CurrentUser().orgId` 取——签发时已验成员资格，后续请求不再每次校验。`cloud_node.org_id`（§3）/ org-grant 判定（§4 第2点）/ 配额（§5）都用它。
> **依赖 SP-0**：本 spec 假设 cloudToken 已含正确的当前 orgId（SP-0 负责登录/注册/切组织时签入）。**不复用 IM 的 `resolveOrgId(userId)`**（按 membership 猜，多组织取不准；其隐患由 SP-0 一并修）。

- **继承**：共享一个文件夹 = 子树内容按该 grant 可见；子项可再加 grant 提权（取最高）。
- **能力映射**：`viewer` 可 list/download-url；`editor` 可 upload/folder/rename/move/delete（在该节点子树内）；改 grant（共享设置）仅 `owner`。
- **实现**：一次性把 node 到根的祖先链查出（递归 CTE 或应用层逐级查 + 缓存父链），收集祖先 + 自身的 grant 做判定。列目录时对结果集批量判权限。

**「共享给我的」虚拟视图**：`GET /api/drive/shared` 查 `grantee=user:me 或 grantee=org:myOrg` 的**最浅**被授权节点（其祖先未被授权给我的那些），作为虚拟根列出；不在真实树里移动位置。

## 5. 配额

- 按**组织**计：`DRIVE_ORG_QUOTA_BYTES`（v1 配置常量，默认 5 GiB；env 可覆盖）。
- 已用 = `SUM(size_bytes) WHERE org_id=? AND type='file' AND status='ready'`。
- upload-request 时校验 `已用 + 声明 size ≤ 配额`，超则 `DRIVE_QUOTA_EXCEEDED`。
- complete 时以 Minio `statObject` 真实 size 为准回填（声明 size 仅预检）。

## 6. 接口（server-main `/api/drive/*`，JwtAuthGuard）

| 方法 | 路径 | 说明 | 最低权限 |
|------|------|------|----------|
| GET | `/nodes?parentId=` | 列目录（parentId 空=用户根）；返回子节点 + 各自我方 permission | viewer(父) |
| GET | `/shared` | 「共享给我的」虚拟根 | — |
| GET | `/quota` | org 配额 + 已用 | — |
| POST | `/folders` | 建文件夹 `{ name, parentId }` | editor(父) |
| POST | `/uploads` | `{ name, parentId, size, mime }` → 校验 ACL+配额 → 建 uploading 节点 + presignedPut → `{ nodeId, putUrl }` | editor(父) |
| POST | `/uploads/:nodeId/complete` | `{ checksum? }` → statObject 核实 size → status=ready | owner/editor(节点) |
| GET | `/files/:id/url` | 判 ACL → presignedGet → `{ url, ttl }` | viewer |
| PATCH | `/nodes/:id` | 改名 `{ name }` / 移动 `{ parentId }`（移动校验目标可写 + 防环） | editor |
| DELETE | `/nodes/:id` | 删（文件夹递归删子节点 + Minio 对象） | editor |
| GET | `/nodes/:id/grants` | 列共享设置 | owner |
| PUT | `/nodes/:id/grants` | 覆盖式设共享 `{ grants: [{granteeType, granteeId, permission}] }` | owner |

**server-agent 网关**（`/api/drive/*` 同形）：本地 JWT 鉴权 → `DriveGatewayService` 用当前账号 `CloudIdentity.cloudToken` 经 `CloudClientService` 转发同名接口。presigned `putUrl`/`url` 原样透传给前端，前端直连 Minio。

## 7. 上传 / 下载流程

**上传（presigned 两阶段）**：
1. `POST /uploads`（name+parentId+size+mime）→ ACL(editor 父) + 配额预检 → 建 `cloud_node{status:uploading, asset_key}` → `presignedPutObject(asset_key, ttl)` → `{ nodeId, putUrl }`。
2. 客户端 PUT putUrl 直传 Minio（web-agent 浏览器 / agent 端 server-agent）。
3. `POST /uploads/:nodeId/complete` → `statObject` 取真实 size + 再校验配额 → `status=ready`（超配额则删 Minio 对象 + 节点，返 `DRIVE_QUOTA_EXCEEDED`）。
4. **孤儿清理**：`uploading` 超 `DRIVE_UPLOAD_TTL`（默认 1h）未 complete 的节点，惰性清理（list 时跳过 uploading；定时/惰性删 stale 节点 + 尝试删 Minio 对象）。

**下载/预览（presigned GET）**：`GET /files/:id/url` → ACL(viewer) → `getSignedUrl(asset_key, ttl)` → `{ url }` → 客户端直连 Minio。presigned URL 自带凭证，**iframe/img 可直连预览**（SP-C 复用，绕开 artifact 预览的 header-only 限制）。

## 8. libs/assets 扩展

`AssetService` 加抽象方法 `getUploadUrl(key, ttlSeconds): Promise<string>`；`MinioAssetService` 实现为 `client.presignedPutObject(bucket, key, ttl)`。`statObject` 能力：加 `stat(key): Promise<{ size: number }>`（complete 核实用）。bucket 沿用配置（网盘可单独 bucket `meshbot-drive` 或复用，v1 复用现有配置项加 `drive` 前缀隔离）。

## 9. 错误码（defineErrorCode，主域）

`DRIVE_NODE_NOT_FOUND` / `DRIVE_FORBIDDEN`（无 ACL）/ `DRIVE_QUOTA_EXCEEDED` / `DRIVE_INVALID_MOVE`（移到自身子孙）/ `DRIVE_NAME_CONFLICT`（同父同名）/ `DRIVE_NOT_READY`（对 uploading 节点取下载 url）。

## 10. 测试

- **e2e（server-main，含 Postgres service）**：建夹 / 上传两阶段（mock Minio presigned + statObject）/ 列目录 / 改名 / 移动（防环）/ 删除（递归）/ 配额超限 / **ACL 矩阵**（owner/editor/viewer/无权 × 读/写/共享）/ 继承（共享父→子可见）/ 共享给我的视图。
- **单测**：`resolvePermission` 纯逻辑（继承链 + org/user grant + 最高权限取值）单独覆盖。
- server-agent 网关：单测 DriveGatewayService 带 token 转发 + presigned 透传。
- 围栏：`@Transactional` 跨表写（如删文件夹递归）命名 `*InTx`；check:repo 单一归属（CloudNode/Grant 各一 service）；check:pk（SnowflakeBaseEntity）；check:error-code（新码登记 baseline）。

## 11. 涉及文件（预估）

- 新建 Entity：`libs/main/src/entities/cloud-node.entity.ts` / `cloud-node-grant.entity.ts`。
- 新建 service：`libs/main/src/services/cloud-drive.service.ts`（编排 + ACL + 配额）/ `cloud-node.service.ts`（CloudNode 归属 repo）/ `cloud-node-grant.service.ts`（Grant 归属 repo）。
- 新建 controller：`apps/server-main/src/rest/drive.controller.ts`（org 取自 `@CurrentUser().orgId`；依赖 SP-0 把 orgId 签入 token + `JwtMainPayload` 加 orgId）。
- 新建 DTO/schema：`libs/types-main/src/drive.ts`（Zod：列目录/建夹/上传/grants 等）。
- DDL：`apps/server-main/migrations/<YYYYMMDDHHmm>-cloud-drive.sql`（cloud_node + cloud_node_grant，幂等）。
- libs/assets：`asset.service.ts` + `minio-asset.service.ts` 加 `getUploadUrl` / `stat`。
- server-agent 网关：`apps/server-agent/src/controllers/drive.controller.ts` + `apps/server-agent/src/services/drive-gateway.service.ts`（只带 cloudToken 转发，token 已含 org，无需额外 header）。
- 配置：`DRIVE_ORG_QUOTA_BYTES` / `DRIVE_UPLOAD_TTL` env + schema。
- e2e：`apps/server-main/test/e2e/drive.e2e.spec.ts`。

## 12. 后续子项目（非本 spec）

- **SP-B agent 工具**：drive_list / drive_mkdir / drive_upload（产物→网盘）/ drive_download，走 server-agent 网关，用 account cloudToken。
- **SP-C 网盘 UI**：web-agent「云端文件」页（目录树 + 上传 + 管理 + 共享设置 + 预览）。
- **SP-D 对外分享**：公开短链 + web-main @Public 公开页 + 跨 agent 匿名下载（与 ACL 内部共享是两套）。
