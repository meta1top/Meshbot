# Agent 网盘工具（SP-B：agent drive tools）设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-29
> 关联：**SP-A 网盘后端**（已合并 main `3c63a7c`）提供 `DriveGatewayService` + `/api/drive/*`；复用 [[agent-im-send-hitl]] 的 ConfirmationService HITL + [[artifact-preview]] 的 present_file workspace 读取模式。
> 上层大需求：企业级网盘。SP-B 让 agent 成为网盘一等公民。

## 1. 目标 / 范围

让 agent 能完整操作网盘：列目录 / 建目录 / 上传产物 / 下载文件 / 共享。5 个工具，其中 `drive_share`（改 ACL）走 HITL 人工确认，其余 4 个直接执行。

**SP-B 边界**：
- ✅ types-agent：5 工具 input schema。
- ✅ libs/agent：`DRIVE_PORT` + `DrivePort` 接口 + 5 个 `@Tool`。
- ✅ server-agent：`DriveToolService`（实现 DrivePort）—— metadata 走 SP-A `DriveGatewayService`，字节走裸 fetch 直连 Minio，workspace 读写走 `getWorkspaceDir` + 越界校验；`drive_share` 走 ConfirmationService HITL。
- ✅ web-agent：`drive_share` 确认卡（复用 im_send 卡模式）。
- ❌ **非目标**：网盘 UI（SP-C）、对外公开分享（SP-D）、delete/move/rename 工具（YAGNI，本期不做）、大文件流式（v1 用 Buffer）。

**前置依赖**：SP-A（已合并）的 `DriveGatewayService`（listNodes/createFolder/requestUpload/completeUpload/getFileUrl/getGrants/setGrants，已带账号 cloudToken）。

## 2. 架构

```
LLM tool_call(drive_*)
  ▼
libs/agent: Drive*Tool（@Tool，@Inject(DRIVE_PORT)）
  ▼ DrivePort
server-agent: DriveToolService（implements DrivePort，账号上下文经 ALS）
  ├─ list/mkdir/share-metadata → DriveGatewayService → server-main /api/drive/*
  ├─ upload: 读 workspace 文件 → requestUpload(putUrl) → fetch PUT Minio → completeUpload
  ├─ download: getFileUrl(url) → fetch GET Minio → 写 workspace 文件
  └─ share: ConfirmationService.waitForDecision（挂起）→ 前端确认卡 → setGrants
```

**复用现有模式**：
- **工具定义**：`@Tool` + `MeshbotTool<TArgs, TResult>`（如 present_file）。
- **port 解耦**：`DRIVE_PORT` symbol + `@Global` module 绑定（如 ASK_QUESTION_PORT / IM_SEND_PORT）。
- **workspace 读写**：`MeshbotConfigService.getWorkspaceDir()` + `resolveFilePath` + `startsWith(workspaceDir + sep)` 越界校验（如 present_file）。
- **Minio 直连**：裸 `fetch(presignedUrl, { method, body })`（如 our-market.source 下载 tarball）。
- **HITL**：`ConfirmationService.waitForDecision(key, signal, timeout)`，key = `${cloudUserId}:${sessionId}:${toolCallId}`（如 im_send / ask_question）。

## 3. 工具集（types-agent schema）

| 工具 | input schema | 行为 | HITL |
|------|-------------|------|------|
| `drive_list` | `{ parentId?: string \| null }` | 列目录（null=根）；返回子节点 name/type/id/size/permission | 否 |
| `drive_mkdir` | `{ parentId?: string \| null, name: string }` | 建文件夹；返回新节点 | 否 |
| `drive_upload` | `{ path: string, parentId?: string \| null, name?: string }` | 把 workspace 相对路径的产物上传到网盘（name 默认取文件名）；返回网盘节点 | 否 |
| `drive_download` | `{ fileId: string, destPath: string }` | 下载网盘文件到 workspace 相对路径；返回写入路径 | 否 |
| `drive_share` | `{ nodeId: string, shareWith: string, permission: "viewer" \| "editor" }` | 共享给组织或成员（`shareWith="org"` 或 email）；改 ACL | **是** |

工具返回 JSON 字符串（tools.node 序列化）。错误返回 `Error: ...` 文案（与 present_file 一致，供 LLM 重试/纠正）。

## 4. DrivePort 接口（libs/agent）

```typescript
export const DRIVE_PORT = Symbol("DRIVE_PORT");
export interface DrivePort {
  list(parentId: string | null): Promise<unknown>;
  mkdir(parentId: string | null, name: string): Promise<unknown>;
  upload(path: string, parentId: string | null, name: string | undefined): Promise<unknown>;
  download(fileId: string, destPath: string): Promise<string>;
  share(args: { nodeId: string; shareWith: string; permission: "viewer" | "editor"; sessionId: string; toolCallId: string }, signal: AbortSignal): Promise<unknown>;
}
```

工具是薄壳：注入 `DRIVE_PORT`，`execute` 把 `ctx`（sessionId/toolCallId/signal）+ args 透传给 port（share 才需 sessionId/toolCallId/signal，其余只透传 args）。

## 5. DriveToolService（server-agent，实现 DrivePort）

注入：`DriveGatewayService`（metadata）、`MeshbotConfigService`（workspace 根）、`ConfirmationService`（share HITL）、`CloudClientService`/`CloudIdentityService`（email→userId 解析 + token）、`AccountContextService`。

- **list / mkdir**：直接转 `gateway.listNodes(parentId)` / `gateway.createFolder({name, parentId})`。
- **upload**：
  1. `getWorkspaceDir()` + 越界校验解析 `path` → 绝对路径；`existsSync` + `statSync` 取 size + 读 Buffer。
  2. `gateway.requestUpload({ name: name ?? basename, parentId, size, mime })` → `{ nodeId, putUrl }`。
  3. 裸 `fetch(putUrl, { method:"PUT", body: buffer })`，非 2xx → `DRIVE_UPLOAD_FAILED`。
  4. `gateway.completeUpload(nodeId, { checksum })`（sha256 可选）→ 返回 ready 节点。
- **download**：
  1. `gateway.getFileUrl(fileId)` → `{ url }`。
  2. 裸 `fetch(url)` → `arrayBuffer()` → Buffer。
  3. `getWorkspaceDir()` + 越界校验解析 `destPath` → 绝对路径（mkdir 父目录）→ 写文件 → 返回相对路径。
- **share（HITL）**：
  1. 解析共享目标：`shareWith="org"` → `{granteeType:"org", granteeId: <当前 orgId>}`；否则当 email → 查当前 org 成员（`gateway` 或 CloudClient `GET /api/orgs/:id/members`，先解析当前 org，匹配 email→userId，匹配不到抛 `DRIVE_SHARE_TARGET_INVALID`）。
  2. 查节点名（`gateway.listNodes` 父级或专用查询）用于确认卡展示。
  3. `ConfirmationService.waitForDecision(key, signal, 120_000)` 挂起；前端确认卡显示「把 <节点名> 共享给 <org/email> 为 <permission>」。
  4. 用户确认 → `gateway.getGrants(nodeId)` 读现有 grants → 合并（覆盖同一 grantee 的 permission，否则追加）→ `gateway.setGrants(nodeId, { grants })`。取消/超时 → 返回未共享状态 JSON。

## 6. drive_share 确认卡（web-agent）

复用 im_send 卡模式：
- `tool-call-block` 对 `drive_share` 特判 → 渲染 `DriveShareCard`（pending 显示共享详情 + 确认/取消按钮；终态显示已共享/已取消）。
- 确认/取消走现有 confirm 端点（`POST /api/sessions/:sessionId/confirm`，ConfirmationService.resolve）。payload 含共享详情（节点名 + shareWith + permission），由挂起时 emit 的 pending 事件携带（同 im_send/ask_question 的 pending 卡数据来源）。
- Rules-of-Hooks 合规；TOOL_LABELS 补 `drive_share` 友好中文名（+ 其余 4 个工具友好名）。

## 7. 错误码（AgentErrorCode，agent 域）

复用现有 `AUTH_UNAUTHORIZED`/`CLOUD_UNREACHABLE`；新增 `DRIVE_UPLOAD_FAILED` / `DRIVE_DOWNLOAD_FAILED` / `DRIVE_SHARE_TARGET_INVALID`（按 check:error-code agent 域范围分配；工具层 catch 后返回 `Error: <msg>` 文案给 LLM）。

## 8. 字节传输

v1 整文件 Buffer + fetch（产物多为中小文件，HTML/PDF/MD/图片）。大文件（视频/数据集）流式上传/下载留后续优化（fetch 支持 stream body / Readable，v2 再做）。在工具描述里提示 agent 适用中小产物。

## 9. 测试

- **工具单测**（libs/agent，vitest）：5 个 @Tool execute 透传 args 给 mock DRIVE_PORT；schema 校验。
- **DriveToolService 单测**（server-agent，jest）：mock gateway/fetch/fs/confirmation/identity。覆盖：upload（读 fs→requestUpload→PUT→complete，PUT 失败→DRIVE_UPLOAD_FAILED，越界 path→拒）；download（getFileUrl→GET→写 fs，越界 destPath→拒）；share（org 直解析、email 解析成员、解析不到→TARGET_INVALID、确认→setGrants 合并、取消→不改）；list/mkdir 转发。
- **前端**：DriveShareCard 组件（pending/确认/取消/终态，Rules-of-Hooks）。
- 围栏：check:error-code（新码登记）；agent 工具注册到 agent.module（boot 验证 DI + DRIVE_PORT 绑定）。

## 10. 涉及文件（预估）

- types-agent：`src/drive-tools.ts`（5 schema）。
- libs/agent：`src/tools/drive.port.ts`（DRIVE_PORT + DrivePort）、`src/tools/builtins/drive-{list,mkdir,upload,download,share}.tool.ts`、agent.module 注册。
- server-agent：`src/services/drive-tool.service.ts`（implements DrivePort）、`src/drive-tool.module.ts`（`@Global` 绑定 DRIVE_PORT）、错误码补充。
- web-agent：`components/session/drive-share-card.tsx`、`tool-call-block.tsx` 特判 + TOOL_LABELS。
- 错误码：`AgentErrorCode` 加 DRIVE_UPLOAD_FAILED / DRIVE_DOWNLOAD_FAILED / DRIVE_SHARE_TARGET_INVALID。

## 11. 后续子项目（非本 spec）

- **SP-C 网盘 UI**：web-agent「云端文件」页（目录树 + 上传 + 管理 + 共享设置 + 预览）。
- **SP-D 对外分享**：公开短链 + web-main 匿名公开页 + 跨 agent 下载。
