# 网盘 UI（SP-C：cloud-drive UI）设计

> 状态：已通过 brainstorm（4 决策已定），待评审 → writing-plans
> 日期：2026-06-29
> 关联：SP-A 网盘后端（已合并 main `4a20507`，server-agent 网关 `/api/drive/*`）、复用 [[artifact-preview]] 预览组件 + dock 面板、复用 settings/org 的 useMembers。
> 上层大需求：企业级网盘。SP-A 后端 + SP-B agent 工具已合并；SP-C 是网盘 UI；SP-D 对外分享待做。

## 1. 目标 / 范围

web-agent「云端文件」页：可视化操作网盘——浏览目录、上传产物、新建夹/重命名/移动/删除、共享设置、文件预览。让用户能 UI 操作 SP-A 后端（此前只能靠 agent/curl）。

**SP-C 边界**：
- ✅ `app/(shell)/drive/page.tsx`（ToolPage）+ WorkspaceRail「云端文件」入口。
- ✅ `rest/drive.ts`（raw fn + react-query hooks）。
- ✅ 文件列表 + 面包屑 + 顶部 tab（我的文件 / 共享给我的）。
- ✅ 上传（presigned 两阶段直传 Minio，拖拽 + 选择）。
- ✅ 管理：新建夹 / 重命名 / 移动（弹窗选目标）/ 删除。
- ✅ 共享：DriveShareModal（org 成员下拉 + viewer/editor）。
- ✅ 预览：点文件 → 右侧 dock 预览面板（改造 ArtifactBody 支持 presigned URL）。
- ❌ **非目标**：对外公开分享（SP-D）、回收站、文件搜索、大文件流式上传（v1 整文件）、拖拽移动（用弹窗）、树形侧栏（用面包屑+tab）。

**前置依赖**：SP-A（已合并）+ **Minio CORS 允许 web-agent origin**（presigned 浏览器直传/直下前提，运维配置）。

## 2. 架构

**复用现有骨架**：
- 页面：`ToolPage`（title「云端文件」+ tabs「我的文件/共享给我的」+ actions「上传/新建文件夹」+ children 列表）。放 `app/(shell)/drive/page.tsx`。
- 导航：`WorkspaceRail` 加 `RailNavItem`（Cloud 图标 → `/drive`）；`area-from-path.ts` 加 `"drive"`。
- 数据：`rest/drive.ts` 仿 `rest/org.ts`（apiClient + useQuery/useMutation + queryKey invalidation），全调 server-agent `/api/drive/*`。
- 字节：上传/下载用裸 `fetch` 直连 Minio presigned URL（不经 apiClient）。

**访问链路**：web-agent → server-agent `/api/drive/*`（本地 JWT，DriveGatewayService 带 cloudToken 转发 server-main）；presigned put/get URL 由前端裸 fetch 直连 Minio。

## 3. 布局（决策①：内容区 + 面包屑 + tab）

ToolPage 内容区：
- **tabs**（ToolPage tabs 槽）：`我的文件`（listNodes，根/目录浏览）/ `共享给我的`（listShared，虚拟视图，只读浏览 + 预览/下载）。
- **actions**（ToolPage actions 槽，仅「我的文件」tab）：`上传` 按钮 + `新建文件夹` 按钮。
- **内容体**：`DriveBreadcrumb`（祖先链，根 → 当前夹，点击跳转）+ `DriveFileList`（当前目录子节点）。
- 当前目录 `parentId` 用 page 本地 state（或 URL query `?parentId=`，**用 state 即可**，刷新回根）。

## 4. 组件（`components/drive/`）

- **DriveFileList**：列表（每行：类型图标 + 名称 + 大小 + 修改时间 + 末尾 DropdownMenu）。
  - 文件夹行点击 → 进入（setParentId + 更新面包屑）。
  - 文件行点击 → 预览（见 §7）。
  - 行 DropdownMenu（@meshbot/design DropdownMenu）：重命名 / 移动到… / 删除 / 共享 / 下载（共享/删除仅 owner-or-editor，权限来自 node.permission）。
- **DriveUploadArea / 上传按钮**：拖拽区 + `<input type=file multiple>` → presigned 两阶段（§6）。上传中显示 Progress（@meshbot/design）。
- **DriveBreadcrumb**：祖先链（listNodes 返回的 node 含 parentId，或单独取 ancestors——v1 用前端维护的「进入路径栈」即可，避免额外查询）。
- **DriveMoveModal**（决策③）：「移动到…」弹窗——列出文件夹树/列表供选目标，确认 → `PATCH /api/drive/nodes/:id { parentId }`。v1 简单实现：弹窗内复用 listNodes 逐级浏览选目标夹（不做拖拽）。
- **DriveShareModal**（决策④）：共享设置弹窗——`useMembers(orgId)` 下拉选成员（名字/email）+「整个组织」选项 + viewer/editor 选择，确认 → 读 `getGrants` 合并 + `PUT /api/drive/nodes/:id/grants`。参考 drive-share-card 两态 + settings/org 成员列表。
- **重命名**：行内编辑或小弹窗 → `PATCH { name }`。
- **删除**：确认弹窗 → `DELETE /api/drive/nodes/:id`（文件夹递归后端已处理）。

## 5. rest/drive.ts

raw fn + hooks（仿 org.ts）：
- `fetchNodes(parentId)` / `useDriveNodes(parentId)` → `GET /api/drive/nodes?parentId=`
- `fetchShared()` / `useDriveShared()` → `GET /api/drive/shared`
- `fetchQuota()` / `useDriveQuota()` → `GET /api/drive/quota`
- `createFolder(parentId, name)` / `useCreateFolder()`
- `requestUpload({name, parentId, size, mime})` → `{nodeId, putUrl}`；`completeUpload(nodeId, {checksum?})`
- `getFileUrl(id)` → `{url, ttl}`
- `renameNode(id, name)` / `moveNode(id, parentId)`（PATCH）
- `deleteNode(id)`（DELETE）
- `getGrants(id)` / `setGrants(id, grants)`（GET/PUT）
- mutation onSuccess invalidate `driveNodesQueryKey`（+ quota）。
- `DriveNode` 类型（id/name/type/sizeBytes/mime/status/permission/parentId/createdAt）放 types（前端用，或 types-main 复用 NodeView）。

## 6. 上传（presigned 两阶段）

1. 选/拖文件 → `requestUpload({ name, parentId, size: file.size, mime: file.type })` → `{nodeId, putUrl}`。
2. 裸 `fetch(putUrl, { method:"PUT", body: file, headers:{ "Content-Type": file.type } })` 直传 Minio；非 ok → 报错 + 删 uploading 节点（或留 GC）。
3. `completeUpload(nodeId, {})` → invalidate driveNodesQueryKey。
4. 多文件并发上传 + 每个 Progress；前置 Minio CORS。

## 7. 预览（决策②：复用 dock 预览面板）

点网盘文件 → 右侧 dock 预览面板渲染（与产物预览一致的 dock 体验）：
- **改造 ArtifactBody 支持 presigned URL**：现 ArtifactBody 只认 server-agent `/api/artifacts/raw?path=`（apiClient 带 token blob）。加一种 source：`{ kind: "presigned", url }`——image/html 直接 `src=url`（presigned 自带凭证，iframe/img 直连）；pdf/markdown/text 裸 `fetch(url)`（无 token）→ blob/text。文件类型由 name 扩展名判定（复用 artifactKind）。
- **dock 接入**：扩展 `previewArtifactAtom` 支持网盘文件（携带 presigned url + name + kind）；点网盘文件 → `getFileUrl(id)` 拿 url → 设 previewArtifact（presigned 源）+ panelType=preview → dock 渲染。下载复用 presigned url。
- 「共享给我的」文件同样可预览/下载（viewer 权限）。

## 8. 错误/边界

- 无权操作（后端返 DRIVE_FORBIDDEN）→ toast/提示（前端无全局 toast，用 inline 错误或 alert，与现有一致）。
- 配额（useDriveQuota）：页头或上传区显示 已用/总量；上传超限后端返 DRIVE_QUOTA_EXCEEDED → 提示。
- uploading 节点不在 list（后端已过滤）。
- 行操作按 node.permission 显隐（viewer 不显示 删除/共享/移动/重命名）。

## 9. 测试

- 前端无完善自动测框架 → 主要 `pnpm turbo typecheck --filter=@meshbot/web-agent` + 手动验证。
- 纯逻辑（如 artifactKind 扩展、面包屑路径栈）若抽函数则加 jest/vitest。
- 组件（DriveShareModal/DriveMoveModal）Rules-of-Hooks 合规。
- 手动验证（需 Minio CORS + 登录）：建夹 → 进入 → 上传产物 → 列表见 → 预览 → 下载 → 重命名 → 移动 → 共享（成员下拉）→ 删除 → 「共享给我的」tab。

## 10. 涉及文件（预估）

- 新建：`app/(shell)/drive/page.tsx`、`rest/drive.ts`、`components/drive/{drive-file-list,drive-upload-area,drive-breadcrumb,drive-move-modal,drive-share-modal}.tsx`。
- 改：`components/shell/workspace-rail.tsx`（Cloud 入口）、`lib/area-from-path.ts`（drive）、`components/artifact/artifact-body.tsx`（presigned source）、`atoms/assistant-panel.ts`（previewArtifact 支持网盘 presigned 源）、i18n（drive UI 文案 + rail.drive）。
- 复用：ToolPage/PageShell、artifact 预览、useMembers、@meshbot/design 组件。

## 11. 任务拆分（预估，writing-plans 细化）

1. rest/drive.ts + DriveNode 类型。
2. 页面骨架 + WorkspaceRail 入口 + area + 面包屑 + 文件列表（浏览/进入/tab 我的+共享给我的）。
3. 上传（DriveUploadArea presigned 两阶段 + 进度）。
4. 管理（新建夹 + 重命名 + 删除 + DriveMoveModal 移动）。
5. 共享（DriveShareModal org 成员下拉 + setGrants 合并）。
6. 预览接入（ArtifactBody presigned 改造 + dock 渲染网盘文件 + 下载）。
7. 集成验证（typecheck + 围栏 + 手动）。

## 12. 后续

SP-C 后 → **SP-D 对外分享**（公开短链 + web-main 匿名公开页 + 跨 agent 下载）—— 网盘大需求最后一块。
