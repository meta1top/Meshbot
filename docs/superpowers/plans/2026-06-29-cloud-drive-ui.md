# 网盘 UI（SP-C）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** web-agent「云端文件」页——浏览/上传/管理/共享/预览网盘文件。

**Architecture:** `app/(shell)/drive` 用 ToolPage（tabs 我的/共享给我的）；`rest/drive.ts`（react-query）调 server-agent `/api/drive/*`；上传/下载裸 fetch 直连 Minio presigned；预览复用 dock 面板（改造 ArtifactBody 支持 presigned URL）；共享用 useMembers 下拉。

**Tech Stack:** Next.js App Router（static export）/ Jotai / @tanstack/react-query / @meshbot/design / apiClient（@meshbot/web-common）。

## Global Constraints

- **依赖 SP-A（已合并 main）**：server-agent `/api/drive/*`：`GET nodes?parentId`、`GET shared`、`GET quota`、`POST folders {name,parentId}`、`POST uploads {name,parentId,size,mime}→{nodeId,putUrl}`、`POST uploads/:nodeId/complete {checksum?}`、`GET files/:id/url→{url,ttl}`、`PATCH nodes/:id {name?|parentId?}`、`DELETE nodes/:id`、`GET+PUT nodes/:id/grants`。NodeView = `{id,type,name,sizeBytes,mime,status,permission,createdAt,updatedAt}`（permission: owner|editor|viewer）。
- **前置**：Minio CORS 允许 web-agent origin（presigned 浏览器直传/直下；手动验证需先配，否则上传/预览失败）。
- 页面用 `ToolPage`（仿 `app/(shell)/skills/page.tsx`）；导航 `WorkspaceRail` 加 `RailNavItem`；`area-from-path.ts` 加 `"drive"`。
- rest 仿 `rest/org.ts`（apiClient + useQuery/useMutation + queryKey invalidation）；apiClient from `@meshbot/web-common`。
- 预览复用 dock：改造 `ArtifactBody` 支持 presigned url、扩展 `previewArtifactAtom`。
- 共享成员用 `useMembers`（rest/org.ts，需当前 orgId）。
- Rules-of-Hooks：hooks 在组件顶层、不在 early return 后（弹窗组件尤其）。
- 前端无完善自动测 → 每 task `pnpm turbo typecheck --filter=@meshbot/web-agent` + `npx biome check --write`；纯函数（面包屑栈/类型判定）可加测；UI 行为手动验证（不假装跑 UI）。
- 中文 JSDoc；不在 if 前一行放注释；中文提交；i18n 文案补 `drive.*` + `rail.drive`（`sync:locales --write` 补 stub）。

---

## File Structure

- 新建：`app/(shell)/drive/page.tsx`、`rest/drive.ts`、`components/drive/{drive-file-list,drive-upload-area,drive-breadcrumb,drive-move-modal,drive-share-modal}.tsx`。
- 改：`components/shell/workspace-rail.tsx`、`lib/area-from-path.ts`、`components/artifact/artifact-body.tsx`、`atoms/assistant-panel.ts`、i18n。

---

## Task 1: rest/drive.ts + 导航入口

**Files:**
- Create: `apps/web-agent/src/rest/drive.ts`
- Modify: `components/shell/workspace-rail.tsx`、`lib/area-from-path.ts`、i18n（`rail.drive`）
- Test: typecheck

**Interfaces:**
- Produces: `DriveNode` 类型；`fetchNodes/fetchShared/fetchQuota/createFolder/requestUpload/completeUpload/getFileUrl/renameNode/moveNode/deleteNode/getGrants/setGrants` + hooks `useDriveNodes/useDriveShared/useDriveQuota/useCreateFolder/...`；`driveNodesQueryKey`。

- [ ] **Step 1: rest/drive.ts** — 仿 `rest/org.ts`：

```typescript
import { apiClient } from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** 网盘节点（与 server-main NodeView 对齐）。 */
export interface DriveNode {
  id: string;
  type: "file" | "folder";
  name: string;
  sizeBytes: number;
  mime: string | null;
  status: "uploading" | "ready";
  permission: "owner" | "editor" | "viewer";
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface DriveGrant {
  granteeType: "org" | "user";
  granteeId: string;
  permission: "viewer" | "editor";
}

export const driveNodesQueryKey = ["drive", "nodes"] as const;
export const driveQuotaQueryKey = ["drive", "quota"] as const;

export async function fetchNodes(parentId: string | null): Promise<DriveNode[]> {
  const { data } = await apiClient.get<DriveNode[]>("/api/drive/nodes", {
    params: parentId ? { parentId } : {},
  });
  return data;
}
export async function fetchShared(): Promise<DriveNode[]> {
  const { data } = await apiClient.get<DriveNode[]>("/api/drive/shared");
  return data;
}
export async function fetchQuota(): Promise<{ used: number; limit: number }> {
  const { data } = await apiClient.get<{ used: number; limit: number }>("/api/drive/quota");
  return data;
}
export async function createFolder(parentId: string | null, name: string): Promise<DriveNode> {
  const { data } = await apiClient.post<DriveNode>("/api/drive/folders", { parentId, name });
  return data;
}
export async function requestUpload(body: { name: string; parentId: string | null; size: number; mime: string }): Promise<{ nodeId: string; putUrl: string }> {
  const { data } = await apiClient.post<{ nodeId: string; putUrl: string }>("/api/drive/uploads", body);
  return data;
}
export async function completeUpload(nodeId: string): Promise<DriveNode> {
  const { data } = await apiClient.post<DriveNode>(`/api/drive/uploads/${nodeId}/complete`, {});
  return data;
}
export async function getFileUrl(id: string): Promise<{ url: string; ttl: number }> {
  const { data } = await apiClient.get<{ url: string; ttl: number }>(`/api/drive/files/${id}/url`);
  return data;
}
export async function renameNode(id: string, name: string): Promise<void> {
  await apiClient.patch(`/api/drive/nodes/${id}`, { name });
}
export async function moveNode(id: string, parentId: string | null): Promise<void> {
  await apiClient.patch(`/api/drive/nodes/${id}`, { parentId });
}
export async function deleteNode(id: string): Promise<void> {
  await apiClient.delete(`/api/drive/nodes/${id}`);
}
export async function getGrants(id: string): Promise<DriveGrant[]> {
  const { data } = await apiClient.get<DriveGrant[]>(`/api/drive/nodes/${id}/grants`);
  return data;
}
export async function setGrants(id: string, grants: DriveGrant[]): Promise<void> {
  await apiClient.put(`/api/drive/nodes/${id}/grants`, { grants });
}

export function useDriveNodes(parentId: string | null) {
  return useQuery({ queryKey: [...driveNodesQueryKey, parentId], queryFn: () => fetchNodes(parentId) });
}
export function useDriveShared() {
  return useQuery({ queryKey: ["drive", "shared"], queryFn: fetchShared });
}
export function useDriveQuota() {
  return useQuery({ queryKey: driveQuotaQueryKey, queryFn: fetchQuota });
}
```

（apiClient 的方法名/响应形态对齐 rest/org.ts——若 apiClient 无 `patch`/`delete`/`put`，先 `rg -n "apiClient\.(patch|put|delete)" apps/web-agent/src` 确认，缺则用对应封装。）

- [ ] **Step 2: WorkspaceRail 入口** — `workspace-rail.tsx` 在 more 项后加（import `Cloud` from lucide-react）：

```tsx
<RailNavItem
  icon={<Cloud className="h-5 w-5" />}
  label={t("rail.drive")}
  active={area === "drive"}
  onClick={() => router.push("/drive")}
/>
```

- [ ] **Step 3: area-from-path** — `lib/area-from-path.ts` 加 `/drive` → `"drive"` 分支（先 Read 该文件看现有映射写法）。i18n 加 `rail.drive`（如「云端文件」）+ 跑 `pnpm sync:locales --write` 补 stub。

- [ ] **Step 4: typecheck + commit** — `pnpm turbo typecheck --filter=@meshbot/web-agent`；`git commit -m "feat(web-agent): rest/drive + 网盘导航入口"`

---

## Task 2: 页面骨架 + 面包屑 + 文件列表

**Files:**
- Create: `app/(shell)/drive/page.tsx`、`components/drive/drive-breadcrumb.tsx`、`components/drive/drive-file-list.tsx`
- Test: typecheck + 手动

**Interfaces:** Consumes `useDriveNodes/useDriveShared`、`DriveNode`（Task 1）。Produces 页面（tab 我的/共享给我的 + 面包屑 + 列表）。

- [ ] **Step 1: page.tsx** — ToolPage（仿 skills/page），本地 state：`tab`（"mine"|"shared"）、`pathStack`（`{id,name}[]`，根为 `[]`）。当前 parentId = `pathStack.at(-1)?.id ?? null`。「我的文件」用 `useDriveNodes(parentId)`；「共享给我的」用 `useDriveShared()`（只读，无面包屑、点夹不进入或进入用 nodes）。actions（仅 mine tab）：上传 + 新建夹按钮（Task 3/4 接入，先占位 button）。内容：`<DriveBreadcrumb pathStack onJump>` + `<DriveFileList nodes onEnterFolder onPreview ...>`。用 `<Suspense>` 包（静态导出，若用 useSearchParams 才需；用 state 可不需）。

- [ ] **Step 2: DriveBreadcrumb** — 渲染「根 / 夹1 / 夹2」，点击跳到该层（截断 pathStack）。纯展示 + onJump(index) 回调。

- [ ] **Step 3: DriveFileList** — 列表（每行：类型图标 folder/file 按 mime、名称、大小 formatBytes、修改时间、末尾 DropdownMenu 占位）。文件夹行点击 → `onEnterFolder(node)`（push pathStack）；文件行点击 → `onPreview(node)`（Task 6 接入，先占位）。空列表提示。loading skeleton。

- [ ] **Step 4: typecheck + biome + commit** — typecheck；biome；`git commit -m "feat(web-agent): 网盘页骨架 + 面包屑 + 文件列表"`

---

## Task 3: 上传（presigned 两阶段）

**Files:**
- Create: `components/drive/drive-upload-area.tsx`
- Modify: `app/(shell)/drive/page.tsx`（接入上传按钮/拖拽）
- Test: typecheck + 手动

**Interfaces:** Consumes `requestUpload/completeUpload`（Task 1）、当前 parentId。

- [ ] **Step 1: DriveUploadArea** — 拖拽区 + `<input type=file multiple hidden>`；上传逻辑（useMutation per file）：

```typescript
async function uploadOne(file: File, parentId: string | null) {
  const { nodeId, putUrl } = await requestUpload({
    name: file.name, parentId, size: file.size, mime: file.type || "application/octet-stream",
  });
  const put = await fetch(putUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
  if (!put.ok) throw new Error("上传失败");
  await completeUpload(nodeId);
}
```

成功后 `qc.invalidateQueries({ queryKey: driveNodesQueryKey })`；多文件并发 + 每个进度（Progress 组件可选，v1 至少 loading 态 + 失败提示）。

- [ ] **Step 2: 接入 page** — 上传按钮触发 input.click；page 内容区包 onDragOver/onDrop（拖文件 → uploadOne(每个, parentId)）。仅 mine tab。

- [ ] **Step 3: typecheck + biome + commit** — `git commit -m "feat(web-agent): 网盘上传（presigned 直传 Minio）"`

---

## Task 4: 管理（新建夹 / 重命名 / 删除 / 移动）

**Files:**
- Create: `components/drive/drive-move-modal.tsx`
- Modify: `components/drive/drive-file-list.tsx`（行 DropdownMenu）、`app/(shell)/drive/page.tsx`（新建夹按钮）
- Test: typecheck + 手动

**Interfaces:** Consumes `createFolder/renameNode/moveNode/deleteNode`（Task 1）。

- [ ] **Step 1: 行 DropdownMenu** — DriveFileList 每行末尾 DropdownMenu（@meshbot/design）：重命名 / 移动到… / 删除 / 共享（Task 5）/ 下载（Task 6）。**按 `node.permission` 显隐**：viewer 只显示 下载/预览（不显示 重命名/移动/删除/共享）；editor/owner 全显示；共享仅 owner。
- [ ] **Step 2: 新建夹** — page actions「新建文件夹」→ 小弹窗/prompt 输入名 → `createFolder(parentId, name)` → invalidate。
- [ ] **Step 3: 重命名** — 行内编辑或小弹窗 → `renameNode(id, name)` → invalidate。
- [ ] **Step 4: 删除** — 确认弹窗 → `deleteNode(id)` → invalidate（文件夹递归后端处理；提示「将删除该文件夹及内容」）。
- [ ] **Step 5: DriveMoveModal** — 「移动到…」弹窗：弹窗内用 `useDriveNodes` 逐级浏览文件夹（只显示 folder 行 + 面包屑），选目标 → `moveNode(id, targetParentId)` → invalidate。防呆：不能移到自身或其子（后端 DRIVE_INVALID_MOVE 兜底，前端可选过滤掉自身）。
- [ ] **Step 6: typecheck + biome + commit** — `git commit -m "feat(web-agent): 网盘管理（新建夹/重命名/删除/移动）"`

---

## Task 5: 共享（DriveShareModal）

**Files:**
- Create: `components/drive/drive-share-modal.tsx`
- Modify: `components/drive/drive-file-list.tsx`（共享菜单项打开 modal）
- Test: typecheck + 手动

**Interfaces:** Consumes `getGrants/setGrants`（Task 1）、`useMembers`（rest/org.ts）、当前 orgId（currentUserAtom）。

- [ ] **Step 1: DriveShareModal** — 弹窗（参考 drive-share-card 两态 + Card/Select/Button）：
  - `useMembers(orgId)` 拉当前 org 成员；下拉选项 = 「整个组织」+ 各成员（显示 displayName/email，value 用 `org` 或 `user:<userId>`）。
  - permission Select（viewer/editor）。
  - 打开时 `getGrants(nodeId)` 显示现有共享列表（谁 + 权限，可删）。
  - 确认 → 合并（现有 grants + 新选的，同 grantee 覆盖）→ `setGrants(nodeId, merged)` → 关闭 + invalidate（grants 查询）。
  - orgId 从 currentUserAtom（`user.org?.id`）；无 org 不可共享。
- [ ] **Step 2: 接入** — DriveFileList 共享菜单项（仅 owner）→ 打开 DriveShareModal（nodeId）。
- [ ] **Step 3: typecheck + biome + commit** — `git commit -m "feat(web-agent): 网盘共享设置弹窗（org 成员下拉）"`

---

## Task 6: 预览接入（ArtifactBody presigned 改造 + dock）

**Files:**
- Modify: `components/artifact/artifact-body.tsx`、`atoms/assistant-panel.ts`、`components/drive/drive-file-list.tsx`（点文件预览 + 下载）
- Test: typecheck + 手动

**Interfaces:** Consumes `getFileUrl`（Task 1）、`previewArtifactAtom/assistantPanelTypeAtom`。

- [ ] **Step 1: previewArtifact atom 扩展** — `atoms/assistant-panel.ts` 的 `PreviewArtifact` 加可选 presigned 源：

```typescript
export interface PreviewArtifact {
  path?: string;   // server-agent 产物相对路径（apiClient 带 token）
  url?: string;    // 网盘 presigned URL（裸 fetch，自带凭证）
  name?: string;   // 文件名（presigned 源用它判类型 + 下载名）
  title?: string;
}
```

- [ ] **Step 2: ArtifactBody 支持 presigned** — `artifact-body.tsx` 的 `useArtifactContent` + `ArtifactBody` 改为接 `{ path?, url?, name? }`：类型判定用 `artifactKind(path ?? name ?? "")`；取内容时 `url` → 裸 `fetch(url, ...)`（presigned 自带凭证，无需 apiClient token）→ blob/text，`path` → 现有 apiClient 逻辑。其余渲染（pdf/html/image/markdown/text）不变。`downloadArtifact` 同理：url 源直接 `a.href=url; a.download=name`（presigned 自带凭证），path 源走现有 apiClient。

```typescript
// useArtifactContent 取内容分支：
const fetcher = url
  ? fetch(url).then((r) => isText ? r.text() : r.blob())
  : apiClient.get(artifactRawUrl(path!), { responseType: isText ? "text" : "blob" }).then((res) => res.data);
```

（保持 cancelled 检查在 createObjectURL 前，无泄漏。）

- [ ] **Step 3: 点文件预览 + 下载** — DriveFileList 文件行点击 → `getFileUrl(node.id)` 拿 `{url}` → set `previewArtifactAtom({ url, name: node.name })` + `assistantPanelTypeAtom("preview")` + `assistantPanelOpenAtom(true)` → dock 渲染 ArtifactBody（url 源）。行菜单「下载」→ getFileUrl → `a.href=url; a.download=name; a.click()`。
- [ ] **Step 4: typecheck + biome + commit** — `git commit -m "feat(web-agent): 网盘文件预览/下载接入 dock（ArtifactBody 支持 presigned）"`

---

## Task 7: 集成验证

- [ ] **Step 1: 全包 typecheck** — `rm -rf apps/web-agent/.next && pnpm typecheck` 全绿（注意 web-common 若报 dist 缺失，`rm packages/web-common/tsconfig.tsbuildinfo` 后 `pnpm --filter @meshbot/web-common build`）。
- [ ] **Step 2: jest/vitest** — `pnpm test`：基线外零新增。
- [ ] **Step 3: 围栏 + i18n** — `pnpm check` exit 0；`pnpm sync:locales --check`（drive 文案 stub 齐）。
- [ ] **Step 4: 手动验证（需 Minio CORS + 登录）** — rail「云端文件」入口 → 新建夹 → 进入(面包屑) → 上传产物(拖拽) → 列表见 → 点文件 dock 预览 → 下载 → 重命名 → 移动到… → 共享(成员下拉) → 删除 → 「共享给我的」tab。viewer 权限的行只显示预览/下载。

---

## Self-Review（已核对）

- **Spec 覆盖**：§3 布局(Task2 tab+面包屑)；§4 组件(Task2 列表/Task3 上传/Task4 移动弹窗/Task5 共享弹窗)；§5 rest(Task1)；§6 上传(Task3)；§7 预览(Task6 ArtifactBody presigned + dock)；§8 权限显隐(Task4 Step1)+配额(Task1 useDriveQuota，页头展示可 Task2 补)；§9 测试(各 task typecheck + Task7)。
- **类型一致**：`DriveNode`/`DriveGrant`（Task1）→ 各组件消费一致；`PreviewArtifact` 扩展 path?/url?/name?（Task6）→ ArtifactBody 接口一致；rest hooks 命名贯穿。
- **占位符**：无 TBD；多处"先 Read/rg 确认"（apiClient 动词、area-from-path 写法、useMembers/currentUserAtom）是真实核对。
- **预览改造风险**：ArtifactBody 现被产物预览用（path 源），改造保持 path 源行为不变、新增 url 源分支——不破坏现有产物预览。
- **权限**：行操作按 node.permission 显隐（viewer 只预览/下载），后端 ACL 兜底。
