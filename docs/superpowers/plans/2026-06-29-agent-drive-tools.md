# Agent 网盘工具（SP-B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 能操作网盘——5 个工具（list/mkdir/upload/download/share），其中 drive_share 走 HITL 人工确认，其余 4 个直接执行。

**Architecture:** libs/agent 定义薄壳 `@Tool`（注入 `DRIVE_PORT`），server-agent 的 `DriveToolService` 实现 `DrivePort`：metadata 走 SP-A `DriveGatewayService`、字节走裸 fetch 直连 Minio presigned URL、workspace 读写复用 present_file 越界校验、drive_share 走 `ConfirmationService` 挂起 + 前端确认卡。

**Tech Stack:** NestJS / LangGraph 工具（libs/agent vitest）/ Zod（types-agent）/ ConfirmationService HITL / web-agent（Next.js + Jotai）。

## Global Constraints

- **依赖 SP-A（已合并 main）**：`DriveGatewayService`（listNodes/createFolder/requestUpload/completeUpload/getFileUrl/getGrants/setGrants，已带账号 cloudToken）。server-main `/api/drive/*`：requestUpload 返 `{nodeId, putUrl}`、getFileUrl 返 `{url, ttl}`、setGrants 接 `{grants:[{granteeType,granteeId,permission}]}`（覆盖式）。
- **工具定义**：`@Tool()` + `MeshbotTool<TArgs, string>`，schema 来自 `@meshbot/types-agent`，execute 返回 JSON 字符串；错误返回 `Error: <msg>` 文案（供 LLM 纠正）。
- **port 解耦**：`DRIVE_PORT = Symbol("DRIVE_PORT")`；工具 `@Inject(DRIVE_PORT)`；server-agent 用 `@Global` module 绑定（同 ASK_QUESTION_PORT 模式）。libs/agent 工具单测 mock port，不依赖 server-agent。
- **workspace 越界校验**：`MeshbotConfigService.getWorkspaceDir()` + `resolveFilePath(path, dir)` + `abs !== dir && !abs.startsWith(dir + path.sep)` → 拒（与 present_file 逐字一致）。
- **HITL**：`ConfirmationService.key(cloudUserId, sessionId, toolCallId)` + `waitForDecision<T>(key, signal, 120_000)`，返回 `"timeout"` | `"aborted"` | `payload`（同 ask_question）。
- **Minio 直连**：裸 `fetch(presignedUrl, {method, body})`（同 our-market.source 下载 tarball）。
- **错误码**：`AgentErrorCode`（agent 域）新增 `DRIVE_UPLOAD_FAILED` / `DRIVE_DOWNLOAD_FAILED` / `DRIVE_SHARE_TARGET_INVALID`（按 check:error-code agent 域范围分配——实现时 Read `apps/server-agent/src/errors/agent.error-codes.ts` 取下一个可用 code）。
- libs/agent 测试用 **vitest**；server-agent 用 **jest**。
- 公开方法中文 JSDoc；不在 if 前一行放注释；中文提交。

---

## File Structure

- types-agent：`src/drive-tools.ts`（5 schema + Input 类型）。
- libs/agent：`src/tools/drive.port.ts`（DRIVE_PORT + DrivePort）、`src/tools/builtins/drive-{list,mkdir,upload,download,share}.tool.ts`、agent.module 注册 5 工具。
- server-agent：`src/services/drive-tool.service.ts`（implements DrivePort）、`src/drive-tool.module.ts`（@Global 绑定 DRIVE_PORT）、`errors/agent.error-codes.ts`（加 3 码）、app.module 注册 module。
- web-agent：`components/session/drive-share-card.tsx`、`tool-call-block.tsx`（drive_share 特判）、TOOL_LABELS（5 工具友好名）。

---

## Task 1: schema + DrivePort 契约 + 错误码

**Files:**
- Create: `libs/types-agent/src/drive-tools.ts`
- Create: `libs/agent/src/tools/drive.port.ts`
- Modify: `apps/server-agent/src/errors/agent.error-codes.ts`、types-agent barrel（`rg -l "present-file" libs/types-agent/src/index.ts` 找导出点）
- Test: `libs/types-agent/src/drive-tools.spec.ts`

**Interfaces:**
- Produces: 5 schema + Input 类型（DriveListInput 等）。
- Produces: `DRIVE_PORT` symbol + `DrivePort` 接口（5 方法，全返回 `Promise<string>`）。
- Produces: `AgentErrorCode.{DRIVE_UPLOAD_FAILED, DRIVE_DOWNLOAD_FAILED, DRIVE_SHARE_TARGET_INVALID}`。

- [ ] **Step 1: schema** — `drive-tools.ts`（zod，对齐 `present-file.ts` 写法）：

```typescript
import { z } from "zod";

export const driveListSchema = z.object({
  parentId: z.string().nullable().optional(),
});
export type DriveListInput = z.infer<typeof driveListSchema>;

export const driveMkdirSchema = z.object({
  parentId: z.string().nullable().optional(),
  name: z.string().min(1).max(256),
});
export type DriveMkdirInput = z.infer<typeof driveMkdirSchema>;

export const driveUploadSchema = z.object({
  path: z.string().min(1),
  parentId: z.string().nullable().optional(),
  name: z.string().max(256).optional(),
});
export type DriveUploadInput = z.infer<typeof driveUploadSchema>;

export const driveDownloadSchema = z.object({
  fileId: z.string().min(1),
  destPath: z.string().min(1),
});
export type DriveDownloadInput = z.infer<typeof driveDownloadSchema>;

export const driveShareSchema = z.object({
  nodeId: z.string().min(1),
  shareWith: z.string().min(1),
  permission: z.enum(["viewer", "editor"]),
});
export type DriveShareInput = z.infer<typeof driveShareSchema>;
```

从 types-agent barrel 导出。

- [ ] **Step 2: schema 单测** — `drive-tools.spec.ts`：每个 schema parse 合法/非法各一例（如 driveMkdir 缺 name 报错、driveShare permission 非枚举报错）。

- [ ] **Step 3: DrivePort** — `libs/agent/src/tools/drive.port.ts`：

```typescript
/**
 * DRIVE_PORT —— libs/agent → server-agent 解耦端口（网盘工具）。
 * 5 个网盘工具经此端口调用 server-agent 的 DriveToolService 实现。
 * 无 server-agent 环境（工具单测）可 mock。
 */
export const DRIVE_PORT = Symbol("DRIVE_PORT");

/** 网盘工具端口（实现见 server-agent DriveToolService）。 */
export interface DrivePort {
  /** 列目录（parentId=null 根）。返回 JSON 字符串。 */
  list(parentId: string | null): Promise<string>;
  /** 建文件夹。 */
  mkdir(parentId: string | null, name: string): Promise<string>;
  /** 上传 workspace 文件到网盘。 */
  upload(path: string, parentId: string | null, name: string | undefined): Promise<string>;
  /** 下载网盘文件到 workspace。 */
  download(fileId: string, destPath: string): Promise<string>;
  /** 共享（HITL）：挂起等用户确认后改 ACL。 */
  share(
    args: { nodeId: string; shareWith: string; permission: "viewer" | "editor"; sessionId: string; toolCallId: string },
    signal: AbortSignal,
  ): Promise<string>;
}
```

从 libs/agent barrel 导出 DRIVE_PORT + DrivePort（`rg -l "ASK_QUESTION_PORT" libs/agent/src/index.ts` 找导出点）。

- [ ] **Step 4: 错误码** — Read `apps/server-agent/src/errors/agent.error-codes.ts` 取下一可用 code，加 3 个：`DRIVE_UPLOAD_FAILED` / `DRIVE_DOWNLOAD_FAILED` / `DRIVE_SHARE_TARGET_INVALID`（message 用 i18n key，对齐既有 agent 错误码风格）。

- [ ] **Step 5: 跑测试 + typecheck + commit** — `pnpm test -- drive-tools`（schema）；`pnpm turbo typecheck --filter=@meshbot/types-agent --filter=@meshbot/agent`；`pnpm check:error-code`（新码登记，按提示刷 baseline）；`git commit -m "feat(agent): 网盘工具 schema + DrivePort 契约 + 错误码"`

---

## Task 2: 4 个直接工具（list/mkdir/upload/download）

**Files:**
- Create: `libs/agent/src/tools/builtins/drive-list.tool.ts` / `drive-mkdir.tool.ts` / `drive-upload.tool.ts` / `drive-download.tool.ts`
- Modify: `libs/agent/src/agent.module.ts`（注册 4 工具——`rg -n "PresentFileTool" libs/agent/src/agent.module.ts` 找 providers 列表）
- Test: 各 `*.tool.spec.ts`（vitest，mock DRIVE_PORT）

**Interfaces:**
- Consumes: `DRIVE_PORT`/`DrivePort`（Task 1）、schema（Task 1）。
- Produces: `DriveListTool`/`DriveMkdirTool`/`DriveUploadTool`/`DriveDownloadTool`（@Tool，name=`drive_list`/`drive_mkdir`/`drive_upload`/`drive_download`）。

- [ ] **Step 1: 写工具单测**（vitest，参考 `ask-question.tool` 测试，mock port）—— 以 drive_list 为例，断言 execute 把 args 透传给 port：

```typescript
import { DriveListTool } from "./drive-list.tool";

describe("DriveListTool", () => {
  it("透传 parentId 给 port.list", async () => {
    const port = { list: vi.fn().mockResolvedValue('{"nodes":[]}') } as any;
    const tool = new DriveListTool(port);
    const res = await tool.execute({ parentId: "p1" }, {} as any);
    expect(port.list).toHaveBeenCalledWith("p1");
    expect(res).toBe('{"nodes":[]}');
  });
  it("parentId 缺省 → null", async () => {
    const port = { list: vi.fn().mockResolvedValue("{}") } as any;
    await new DriveListTool(port).execute({}, {} as any);
    expect(port.list).toHaveBeenCalledWith(null);
  });
});
```

drive_mkdir/upload/download 各写类似透传断言（mkdir→`mkdir(parentId??null, name)`；upload→`upload(path, parentId??null, name)`；download→`download(fileId, destPath)`）。

- [ ] **Step 2: 跑验证失败** — `pnpm test -- drive-list.tool`（vitest），Expected: FAIL。

- [ ] **Step 3: 实现 4 工具** — 薄壳（参考 ask_question.tool）。drive_list：

```typescript
import { type DriveListInput, driveListSchema } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { DRIVE_PORT, type DrivePort } from "../drive.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class DriveListTool implements MeshbotTool<DriveListInput, string> {
  readonly name = "drive_list";
  readonly description =
    "List entries (files/folders) in a cloud-drive directory. parentId omitted = root. " +
    "Returns JSON with child nodes (id/name/type/size/permission).";
  readonly schema = driveListSchema;
  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}
  execute(args: DriveListInput, _ctx: ToolContext): Promise<string> {
    return this.port.list(args.parentId ?? null);
  }
}
```

drive_mkdir（`port.mkdir(args.parentId ?? null, args.name)`）、drive_upload（`port.upload(args.path, args.parentId ?? null, args.name)`，description 说明 path 是 workspace 相对路径、适用中小产物）、drive_download（`port.download(args.fileId, args.destPath)`，description 说明 destPath 是 workspace 相对路径）同款薄壳。

- [ ] **Step 4: 注册 agent.module** — 4 工具加 providers（与 PresentFileTool 同列）。

- [ ] **Step 5: 跑测试 + typecheck + commit** — `pnpm test -- drive-list.tool drive-mkdir.tool drive-upload.tool drive-download.tool`（vitest）全过；`pnpm turbo typecheck --filter=@meshbot/agent`；`git commit -m "feat(agent): drive_list/mkdir/upload/download 工具"`

---

## Task 3: drive_share 工具

**Files:**
- Create: `libs/agent/src/tools/builtins/drive-share.tool.ts`
- Modify: `libs/agent/src/agent.module.ts`（注册）
- Test: `drive-share.tool.spec.ts`（vitest，mock port）

**Interfaces:** Consumes `DRIVE_PORT`/`driveShareSchema`（Task 1）。Produces `DriveShareTool`（name=`drive_share`）。

- [ ] **Step 1: 单测** — 断言 execute 把 args + ctx（sessionId/toolCallId/signal）透传给 port.share：

```typescript
it("透传 nodeId/shareWith/permission + ctx 给 port.share", async () => {
  const port = { share: vi.fn().mockResolvedValue('{"status":"shared"}') } as any;
  const ctx = { sessionId: "s1", toolCallId: "t1", signal: new AbortController().signal } as any;
  await new DriveShareTool(port).execute(
    { nodeId: "n1", shareWith: "org", permission: "viewer" }, ctx,
  );
  expect(port.share).toHaveBeenCalledWith(
    { nodeId: "n1", shareWith: "org", permission: "viewer", sessionId: "s1", toolCallId: "t1" },
    ctx.signal,
  );
});
```

- [ ] **Step 2: 跑失败** — `pnpm test -- drive-share.tool`，FAIL。

- [ ] **Step 3: 实现** —

```typescript
@Injectable()
@Tool()
export class DriveShareTool implements MeshbotTool<DriveShareInput, string> {
  readonly name = "drive_share";
  readonly description =
    "Share a cloud-drive file/folder with the whole organization (shareWith='org') " +
    "or a colleague (shareWith=their email), as viewer or editor. " +
    "This requires the user to confirm before the ACL change is applied. " +
    "Returns JSON: status shared / cancelled / timeout.";
  readonly schema = driveShareSchema;
  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}
  execute(args: DriveShareInput, ctx: ToolContext): Promise<string> {
    return this.port.share(
      { ...args, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId },
      ctx.signal,
    );
  }
}
```

- [ ] **Step 4: 注册 + 测试 + commit** — agent.module 注册；`pnpm test -- drive-share.tool` 过；`pnpm turbo typecheck --filter=@meshbot/agent`；`git commit -m "feat(agent): drive_share 工具（HITL）"`

---

## Task 4: DriveToolService 直接部分 + DRIVE_PORT 绑定

**Files:**
- Create: `apps/server-agent/src/services/drive-tool.service.ts`（list/mkdir/upload/download，share 留 Task 5）
- Create: `apps/server-agent/src/drive-tool.module.ts`（@Global 绑定 DRIVE_PORT）
- Modify: `apps/server-agent/src/app.module.ts`（imports DriveToolModule）
- Test: `drive-tool.service.spec.ts`（jest，mock gateway/fetch/fs/config）

**Interfaces:**
- Consumes: `DrivePort`（Task 1）、`DriveGatewayService`（SP-A）、`MeshbotConfigService`、`AgentErrorCode`（Task 1）。
- Produces: `DriveToolService implements DrivePort`；`DRIVE_PORT` → DriveToolService 绑定。

- [ ] **Step 1: 写单测**（jest，mock）—— 覆盖：
  - list → `gateway.listNodes(parentId)`，结果 JSON.stringify。
  - mkdir → `gateway.createFolder({name, parentId})`。
  - upload：mock `getWorkspaceDir` 返回 tmp 目录 + 放一个文件；mock gateway.requestUpload 返 `{nodeId, putUrl}`、completeUpload 返 ready 节点；mock 全局 fetch 返 `{ok:true}`；断言读了文件 + PUT putUrl + completeUpload 被调；越界 path（`../etc`）→ 返回 `Error: ... outside workspace`，不调 gateway；fetch 非 2xx → `DRIVE_UPLOAD_FAILED`。
  - download：mock getFileUrl 返 `{url}`、fetch 返 arrayBuffer；断言写入 workspace 文件 + 返回相对路径；越界 destPath → 拒。

  关键 mock 模式（fetch 全局）：

```typescript
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
// upload 成功：
global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
// download：
global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("hi").buffer }) as never;
```

- [ ] **Step 2: 跑失败** — `pnpm test -- drive-tool.service`，FAIL。

- [ ] **Step 3: 实现 DriveToolService（4 直接方法）** — 关键逻辑（越界校验逐字复用 present_file）：

```typescript
@Injectable()
export class DriveToolService implements DrivePort {
  constructor(
    private readonly gateway: DriveGatewayService,
    private readonly config: MeshbotConfigService,
    // Task 5 再加 confirmation/cloud/identity/account
  ) {}

  async list(parentId: string | null): Promise<string> {
    return JSON.stringify(await this.gateway.listNodes(parentId));
  }
  async mkdir(parentId: string | null, name: string): Promise<string> {
    return JSON.stringify(await this.gateway.createFolder({ name, parentId }));
  }
  async upload(p: string, parentId: string | null, name: string | undefined): Promise<string> {
    const dir = this.config.getWorkspaceDir();
    const abs = resolveFilePath(p, dir);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      return `Error: path is outside the workspace: ${p}`;
    }
    if (!existsSync(abs)) return `Error: file does not exist: ${p}`;
    const buf = readFileSync(abs);
    const fileName = name ?? path.basename(abs);
    const mime = lookupMime(abs); // 用既有 mime 工具或 "application/octet-stream" 兜底
    const req = (await this.gateway.requestUpload({
      name: fileName, parentId, size: buf.length, mime,
    })) as { nodeId: string; putUrl: string };
    const put = await fetch(req.putUrl, { method: "PUT", body: buf });
    if (!put.ok) throw new AppError(AgentErrorCode.DRIVE_UPLOAD_FAILED);
    const node = await this.gateway.completeUpload(req.nodeId, {});
    return JSON.stringify({ status: "uploaded", node });
  }
  async download(fileId: string, destPath: string): Promise<string> {
    const dir = this.config.getWorkspaceDir();
    const abs = resolveFilePath(destPath, dir);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      return `Error: path is outside the workspace: ${destPath}`;
    }
    const { url } = (await this.gateway.getFileUrl(fileId)) as { url: string };
    const res = await fetch(url);
    if (!res.ok) throw new AppError(AgentErrorCode.DRIVE_DOWNLOAD_FAILED);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    return JSON.stringify({ status: "downloaded", path: path.relative(dir, abs) });
  }
  // share —— Task 5
  share(): Promise<string> { throw new Error("not implemented (Task 5)"); }
}
```

（`resolveFilePath` import 自 libs/agent 的 file-path.util——确认导出路径；mime 用既有工具，`rg -n "application/octet-stream|mime" apps/server-agent/src libs/agent/src` 找现成的，无则简单按扩展名映射或兜底 octet-stream。）

- [ ] **Step 4: DRIVE_PORT 绑定** — `drive-tool.module.ts`（@Global，同 ask-question.module）：

```typescript
@Global()
@Module({
  imports: [/* DriveGatewayService 所在 module + ConfigModule */],
  providers: [
    DriveToolService,
    { provide: DRIVE_PORT, useExisting: DriveToolService },
  ],
  exports: [DriveToolService],
})
export class DriveToolModule {}
```

app.module imports DriveToolModule。先 Read `ask-question.module.ts` + app.module 确认 DriveGatewayService/MeshbotConfigService 的可注入来源（它们各自所在 module 是否 @Global 或需 imports）。

- [ ] **Step 5: 跑测试 + typecheck + boot** — `pnpm test -- drive-tool.service` 过；`pnpm turbo typecheck --filter=@meshbot/server-agent`；**boot 验证** `pnpm dev:server-agent` 看启动无 `UnknownDependenciesException`、`DRIVE_PORT` 绑定成功、4 工具在 agent 注册（DI 解析通过——工具注入 DRIVE_PORT 现在有绑定）。

- [ ] **Step 6: commit** — `git commit -m "feat(server-agent): DriveToolService 直接工具（list/mkdir/upload/download）+ DRIVE_PORT 绑定"`

---

## Task 5: DriveToolService.share（HITL + email 解析）

**Files:**
- Modify: `apps/server-agent/src/services/drive-tool.service.ts`（实现 share）
- Modify: `drive-tool.module.ts`（补注入 ConfirmationService/CloudClient/CloudIdentity/AccountContext）
- Test: `drive-tool.service.spec.ts`（追加 share 用例）

**Interfaces:** Consumes `ConfirmationService.key/waitForDecision`（同 ask_question）、`DriveGatewayService.getGrants/setGrants`、当前 org 解析（成员查 by email）。

- [ ] **Step 1: 写 share 单测** — mock confirmation/gateway/cloud/identity/account：
  - `shareWith="org"`：确认通过 → getGrants 返现有 → setGrants 含 org grant（granteeId=当前 orgId）。
  - `shareWith=email`：mock 成员查返回含该 email→userId → setGrants 含 user grant。
  - email 匹配不到成员 → 返回 `Error: ...`（或抛 DRIVE_SHARE_TARGET_INVALID）。
  - 确认 `"aborted"`/`"timeout"` → 返回 `{status:"cancelled"|"timeout"}`，不调 setGrants。
  - setGrants 合并：现有 grants + 新 grant（同 grantee 覆盖 permission，否则追加）。

- [ ] **Step 2: 跑失败** — `pnpm test -- drive-tool.service`，新 share 用例 FAIL。

- [ ] **Step 3: 实现 share** —

```typescript
async share(
  args: { nodeId: string; shareWith: string; permission: "viewer" | "editor"; sessionId: string; toolCallId: string },
  signal: AbortSignal,
): Promise<string> {
  // 解析 grantee（org 直用当前 org；email 查成员）
  const grantee = await this.resolveGrantee(args.shareWith); // {granteeType, granteeId} 或 null
  if (!grantee) {
    return `Error: cannot resolve share target: ${args.shareWith}`;
  }
  const key = ConfirmationService.key(this.account.getOrThrow(), args.sessionId, args.toolCallId);
  const outcome = await this.confirmation.waitForDecision(key, signal, 120_000);
  if (outcome === "timeout") return JSON.stringify({ status: "timeout" });
  if (outcome === "aborted") return JSON.stringify({ status: "cancelled" });
  // 确认通过 → 读现有 grants 合并后覆盖式 setGrants
  const existing = ((await this.gateway.getGrants(args.nodeId)) as { grants?: Array<{granteeType:string;granteeId:string;permission:string}> }).grants ?? [];
  const merged = mergeGrant(existing, { ...grantee, permission: args.permission });
  await this.gateway.setGrants(args.nodeId, { grants: merged });
  return JSON.stringify({ status: "shared", shareWith: args.shareWith, permission: args.permission });
}
```

- `resolveGrantee(shareWith)`：`"org"` → `{granteeType:"org", granteeId: <当前 orgId>}`（当前 orgId 怎么拿——优先从 token 解析或经一个 profile/me 接口；先 Read 现有 server-agent 怎么拿当前 orgId，如 CloudIdentity.orgId 镜像）；否则查 org 成员列表匹配 email→userId（`CloudClientService.get("/api/orgs/:id/members")` 或经 gateway，先解析当前 org）→ `{granteeType:"user", granteeId:userId}`；匹配不到 → null。
- `mergeGrant(existing, g)`：同 `(granteeType, granteeId)` 覆盖 permission，否则 push。
- **确认卡数据**：前端确认卡从 tool_call args（nodeId/shareWith/permission）渲染（同 ask_question 卡从 args 读问题，无需额外 emit pending payload）。v1 显示 shareWith + permission；节点名不在 args 里，v1 不显示节点名（留 SP-C 网盘 UI 有节点上下文时补）。share() 服务端不需为前端额外传数据。

- [ ] **Step 4: 跑测试 + typecheck + boot + commit** — `pnpm test -- drive-tool.service` 全过；typecheck；boot 验证；`git commit -m "feat(server-agent): drive_share HITL（确认 + email 解析 + setGrants 合并）"`

---

## Task 6: web-agent drive_share 确认卡

**Files:**
- Create: `apps/web-agent/src/components/session/drive-share-card.tsx`
- Modify: `apps/web-agent/src/components/session/tool-call-block.tsx`（drive_share 特判）、TOOL_LABELS（`rg -n "TOOL_LABELS" apps/web-agent/src` 找）
- Test: typecheck + 手动

**Interfaces:** Consumes drive_share tool_call（pending/终态）+ confirm 端点（`POST /api/sessions/:sessionId/confirm`）。

- [ ] **Step 1: DriveShareCard** — 参考 im_send 确认卡（`rg -l "im.*send.*card|ImSendCard|confirm" apps/web-agent/src/components/session`）：pending 显示「共享给 <shareWith> 为 <permission>」（数据来自 tool_call args 的 shareWith/permission；节点名 args 里没有，v1 不显示节点名）+ 确认/取消按钮；确认调 confirm 端点 resolve（payload 空或 {confirmed:true}，与现有 confirm 卡一致）；终态显示已共享/已取消。Rules-of-Hooks 合规（hooks 不放条件分支后）。

- [ ] **Step 2: tool-call-block 特判** — drive_share → 渲染 DriveShareCard（参考 present_file/ask_question/im_send 的特判分支）。

- [ ] **Step 3: TOOL_LABELS** — 加 5 个友好中文名：`drive_list`→「列网盘目录」、`drive_mkdir`→「新建网盘文件夹」、`drive_upload`→「上传到网盘」、`drive_download`→「从网盘下载」、`drive_share`→「共享网盘文件」。

- [ ] **Step 4: typecheck + biome + commit** — `pnpm turbo typecheck --filter=@meshbot/web-agent`；`npx biome check --write` 改动文件；`git commit -m "feat(web-agent): drive_share 确认卡 + 网盘工具友好名"`

---

## Task 7: 集成验证

- [ ] **Step 1: 全包 typecheck** — `pnpm typecheck` 全绿。
- [ ] **Step 2: 全量 jest + vitest** — `pnpm test`（jest：基线 session.e2e/use-global-events 外零新增；新增 drive-tool.service 过）；`pnpm --filter @meshbot/agent test`（vitest：libs/agent 基线失败外零新增，新增 5 工具测试过）。
- [ ] **Step 3: 静态围栏** — `pnpm check` exit 0（check:error-code 新码 baseline、check:repo、check:naming）。
- [ ] **Step 4: boot 验证** — `pnpm dev:server-agent`：5 工具 DI 解析通过、`DRIVE_PORT` 绑定、无 UnknownDependenciesException。
- [ ] **Step 5: 手动冒烟（可选，需 Minio+Postgres+登录）** — agent 会话里让它 drive_mkdir + drive_upload 一个 workspace 产物 + drive_list 看到 + drive_download 回来 + drive_share 弹确认卡。

---

## Self-Review（已核对）

- **Spec 覆盖**：§3 五工具 schema（Task 1）；§4 DrivePort（Task 1）；§5 DriveToolService（Task 4 直接 + Task 5 share）；§6 确认卡（Task 6）；§7 错误码（Task 1）；§8 字节 Buffer+fetch（Task 4）；§9 测试（各 task TDD + Task 7）。
- **类型一致**：`DrivePort` 5 方法签名（Task 1）→ 工具 execute 调用（Task 2/3）+ DriveToolService 实现（Task 4/5）一致，全返回 `Promise<string>`；`DRIVE_PORT` symbol 贯穿；schema Input 类型（Task 1）→ 工具泛型一致。
- **占位符**：无 TBD；多处"先 Read/rg 确认"是真实代码核对（barrel 落点、mime 工具、当前 orgId 来源、pending 卡数据传递、confirm 端点），非占位。
- **HITL 一致性**：drive_share 复用 ConfirmationService.key/waitForDecision（与 ask_question 同签名）；确认卡复用 confirm 端点。
- **port 绑定时序**：工具注册（Task 2/3 到 agent.module）+ DRIVE_PORT 绑定（Task 4 @Global module）——Task 4 boot 时两者都在，DI 解析通过；Task 2/3 工具 vitest mock port 不 boot。
