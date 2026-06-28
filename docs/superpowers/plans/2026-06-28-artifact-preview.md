# 本地产物预览（present_file → 文件框 → dock 预览）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 调 `present_file` 呈现结果文件 → 对话流文件框 → 点击在右侧 dock 显示预览面板（助手↔预览切换）→ 下载/全屏/关闭，分享占位。

**Architecture:** `present_file` 是普通工具，文件框是它的 tool-call 特判渲染（复用现有 tool-call 链路，零消息字段/零 socket 事件）；产物内容实时读 workspace，经 server-agent 新建 serving 端点（账号作用域 + 路径遍历防护）流式返回；dock 用 `panelType` atom 在助手/预览间切换。

**Tech Stack:** NestJS（server-agent，jest）/ libs/agent（vitest）/ Next.js+Jotai（web-agent，jest）/ Zod。

## Global Constraints

- **零消息字段**：`present_file` 走现有 tool-call 持久化，**不**改 SessionMessage、**不**加 socket 事件。
- **账号作用域 + 路径遍历防护**：serving 端点 workspace 用 `MeshbotConfigService.getWorkspaceDir()`（内部 `account.getOrThrow()`）；解析后的绝对路径必须在 workspace 内（`startsWith`），否则 403；不存在 404。
- **实时读**：文件被改/删 → serving 404，预览显示「产物已不存在或已变更」。
- **present_file 路径**：工具返回**相对 workspace** 的路径；前端文件框/预览/serving 都用相对路径（serving 不接收绝对路径）。
- libs/agent 框架无关：工具纯 `@Tool()` + fs（同 write_file，注入 MeshbotConfigService，无端口）。libs/types-* 纯 Zod。
- html 预览 iframe 必须 `sandbox`。serving URL 用相对路径（同源）。
- Rules of Hooks：tool-call-block 的 present_file 特判早返回放 `useState(open)` 之后。
- 中文 JSDoc；不在 `if` 前一行放注释；中文提交；commit 前 `pnpm check`。

---

## File Structure

**新建**：`libs/types-agent/src/present-file.ts`(+spec)、`libs/agent/src/tools/builtins/present-file.tool.ts`(+test)、`apps/server-agent/src/controllers/artifact.controller.ts`(+spec)、`apps/web-agent/src/lib/artifact.ts`(+spec)、`apps/web-agent/src/components/session/artifact-file-card.tsx`、`apps/web-agent/src/components/artifact/artifact-body.tsx`、`apps/web-agent/src/components/artifact/artifact-preview-panel.tsx`、`apps/web-agent/src/components/artifact/artifact-fullscreen.tsx`。
**改**：`libs/types-agent/src/index.ts`、`libs/agent/src/agent.module.ts`、`apps/server-agent/src/app.module.ts`、`apps/web-agent/src/atoms/assistant-panel.ts`、`apps/web-agent/src/components/session/tool-call-block.tsx`、`apps/web-agent/src/components/layouts/app-shell-layout.tsx`、`apps/web-agent/src/lib/tool-display.ts`。

---

## Task 1: types-agent — present_file schema

**Files:** Create `libs/types-agent/src/present-file.ts` + `present-file.spec.ts`；Modify `libs/types-agent/src/index.ts`

**Interfaces:** Produces `presentFileSchema` → `{ path: string; title?: string }`；类型 `PresentFileInput`、`PresentedArtifact`（工具返回的结构 `{ status, path, name, size }`）。

- [ ] **Step 1: 写失败单测** — `libs/types-agent/src/present-file.spec.ts`：

```ts
import { describe, expect, it } from "@jest/globals";
import { presentFileSchema } from "./present-file";

describe("presentFileSchema", () => {
  it("接受 path + 可选 title", () => {
    const p = presentFileSchema.parse({ path: "report.html", title: "报告" });
    expect(p.path).toBe("report.html");
    expect(p.title).toBe("报告");
  });
  it("title 可省略", () => {
    expect(presentFileSchema.parse({ path: "a.md" }).title).toBeUndefined();
  });
  it("path 非空", () => {
    expect(() => presentFileSchema.parse({ path: "" })).toThrow();
  });
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm test -- libs/types-agent/src/present-file.spec.ts`（FAIL）。
- [ ] **Step 3: 实现** — `libs/types-agent/src/present-file.ts`：

```ts
import { z } from "zod";

/** present_file 工具入参：呈现一个 workspace 内的结果文件。 */
export const presentFileSchema = z.object({
  path: z.string().min(1),
  title: z.string().optional(),
});
export type PresentFileInput = z.infer<typeof presentFileSchema>;

/** present_file 工具返回（JSON 字符串解析后）的产物描述。 */
export interface PresentedArtifact {
  status: "presented";
  path: string;
  name: string;
  size: number;
}
```

- [ ] **Step 4: 跑通过** — 同 Step 2，PASS。
- [ ] **Step 5: 导出 + 提交** — index.ts 加 `export * from "./present-file";`；

```bash
pnpm turbo typecheck --filter=@meshbot/types-agent
git add libs/types-agent/src/present-file.ts libs/types-agent/src/present-file.spec.ts libs/types-agent/src/index.ts
git commit -m "feat(types-agent): present_file 工具 schema"
```

---

## Task 2: libs/agent — present_file 工具

**Files:** Create `libs/agent/src/tools/builtins/present-file.tool.ts`、`libs/agent/tests/unit/present-file.tool.test.ts`；Modify `libs/agent/src/agent.module.ts`

**Interfaces:** Consumes `presentFileSchema`（Task 1）、`MeshbotConfigService`（`getWorkspaceDir()`）、`resolveFilePath`（`./file-path.util`）。Produces 工具 name `present_file`，返回 `PresentedArtifact` 的 JSON 字符串（path 为相对 workspace）。

- [ ] **Step 1: 写失败单测** — `libs/agent/tests/unit/present-file.tool.test.ts`：

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { PresentFileTool } from "../../src/tools/builtins/present-file.tool";

function toolWith(ws: string) {
  const config = { getWorkspaceDir: () => ws } as unknown as MeshbotConfigService;
  return new PresentFileTool(config);
}
const ctx = { sessionId: "s1", toolCallId: "t1" } as never;

describe("present_file tool", () => {
  it("呈现 workspace 内存在的文件 → 返回相对 path + name + size", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "report.html"), "<h1>hi</h1>");
    const out = JSON.parse(await toolWith(ws).execute({ path: "report.html" }, ctx));
    expect(out.status).toBe("presented");
    expect(out.path).toBe("report.html");
    expect(out.name).toBe("report.html");
    expect(out.size).toBeGreaterThan(0);
  });
  it("文件不存在 → 错误字符串", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    const out = await toolWith(ws).execute({ path: "nope.md" }, ctx);
    expect(out.toLowerCase()).toContain("error");
  });
  it("越界路径（workspace 外）→ 错误字符串", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    const out = await toolWith(ws).execute({ path: "../../etc/passwd" }, ctx);
    expect(out.toLowerCase()).toContain("error");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd libs/agent && npx vitest run tests/unit/present-file.tool.test.ts`（FAIL）。
- [ ] **Step 3: 实现** — `libs/agent/src/tools/builtins/present-file.tool.ts`：

```ts
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  type PresentFileInput,
  presentFileSchema,
} from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { resolveFilePath } from "./file-path.util";

@Injectable()
@Tool()
export class PresentFileTool implements MeshbotTool<PresentFileInput, string> {
  readonly name = "present_file";
  readonly description =
    "Present a finished result file (report, web page, chart, PDF, image, etc.) " +
    "to the user as a clickable preview card. Call this AFTER you have produced " +
    "the final artifact in the workspace. Do NOT call it for intermediate/scratch " +
    "files. The path is absolute or relative to the workspace.";
  readonly schema = presentFileSchema;

  constructor(private readonly config: MeshbotConfigService) {}

  /** 校验文件在 workspace 内且存在，返回相对路径 + 元信息（JSON）。 */
  execute(args: PresentFileInput, _ctx: ToolContext): Promise<string> {
    const workspaceDir = this.config.getWorkspaceDir();
    const abs = resolveFilePath(args.path, workspaceDir);
    if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
      return Promise.resolve(`Error: path is outside the workspace: ${args.path}`);
    }
    if (!existsSync(abs)) {
      return Promise.resolve(`Error: file does not exist: ${args.path}`);
    }
    const rel = path.relative(workspaceDir, abs);
    const result = {
      status: "presented",
      path: rel,
      name: path.basename(abs),
      size: statSync(abs).size,
    };
    return Promise.resolve(JSON.stringify(result));
  }
}
```

- [ ] **Step 4: 跑通过** — 同 Step 2，PASS（3 用例）。
- [ ] **Step 5: 注册** — `agent.module.ts`：import `PresentFileTool` + providers 数组（`WriteFileTool` 附近）加 `PresentFileTool,`（先 `rg -n "WriteFileTool" libs/agent/src/agent.module.ts` 定位）。
- [ ] **Step 6: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/agent
git add libs/agent/src/tools/builtins/present-file.tool.ts libs/agent/tests/unit/present-file.tool.test.ts libs/agent/src/agent.module.ts
git commit -m "feat(agent): present_file 工具（呈现 workspace 产物）"
```

---

## Task 3: server-agent — 产物 serving 端点

**Files:** Create `apps/server-agent/src/controllers/artifact.controller.ts` + `artifact.controller.spec.ts`；Modify `apps/server-agent/src/app.module.ts`

**Interfaces:** Consumes `MeshbotConfigService`（`@meshbot/agent`，`getWorkspaceDir()`）。Produces `GET /api/artifacts/raw?path=&download=`。

- [ ] **Step 1: 写失败单测** — `apps/server-agent/src/controllers/artifact.controller.spec.ts`：

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { MeshbotConfigService } from "@meshbot/agent";
import { ArtifactController } from "./artifact.controller";

function make(ws: string) {
  const config = { getWorkspaceDir: () => ws } as unknown as MeshbotConfigService;
  return new ArtifactController(config);
}
function fakeRes() {
  const headers: Record<string, string> = {};
  return { setHeader: (k: string, v: string) => { headers[k] = v; }, headers } as never;
}

describe("ArtifactController.raw", () => {
  it("workspace 内文件 → StreamableFile + Content-Type", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "a.html"), "<h1>x</h1>");
    const res = fakeRes();
    const out = make(ws).raw("a.html", undefined, res);
    expect(out).toBeDefined();
    expect((res as unknown as { headers: Record<string, string> }).headers["Content-Type"]).toBe("text/html");
  });
  it("download=1 → Content-Disposition attachment", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "a.md"), "# x");
    const res = fakeRes();
    make(ws).raw("a.md", "1", res);
    expect((res as unknown as { headers: Record<string, string> }).headers["Content-Disposition"]).toContain("attachment");
  });
  it("路径遍历 ../ → ForbiddenException", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    expect(() => make(ws).raw("../../etc/passwd", undefined, fakeRes())).toThrow(ForbiddenException);
  });
  it("不存在 → NotFoundException", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    expect(() => make(ws).raw("nope.md", undefined, fakeRes())).toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm test -- apps/server-agent/src/controllers/artifact.controller.spec.ts`（FAIL）。
- [ ] **Step 3: 实现** — `apps/server-agent/src/controllers/artifact.controller.ts`：

```ts
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { MeshbotConfigService } from "@meshbot/agent";
import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

/** 扩展名 → Content-Type（预览/下载用，缺省二进制流）。 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 产物文件实时 serving：按账号 workspace 解析、防遍历、流式返回。 */
@ApiTags("artifacts")
@Controller("api/artifacts")
export class ArtifactController {
  constructor(private readonly config: MeshbotConfigService) {}

  /** 读取 workspace 内产物文件（预览/下载）。 */
  @Get("raw")
  @ApiOperation({ summary: "读取 workspace 内产物文件（预览/下载）" })
  raw(
    @Query("path") relPath: string,
    @Query("download") download: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const workspaceDir = this.config.getWorkspaceDir();
    const abs = path.resolve(workspaceDir, relPath ?? "");
    if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
      throw new ForbiddenException("path outside workspace");
    }
    if (!existsSync(abs)) {
      throw new NotFoundException("artifact not found");
    }
    res.setHeader(
      "Content-Type",
      CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    );
    if (download === "1") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(path.basename(abs))}"`,
      );
    }
    return new StreamableFile(createReadStream(abs));
  }
}
```

- [ ] **Step 4: 跑通过** — 同 Step 2，PASS（4 用例）。
- [ ] **Step 5: 注册 controller** — `app.module.ts`：import `ArtifactController` + 加进 `controllers: [...]` 数组（先 `rg -n "controllers:" apps/server-agent/src/app.module.ts` 定位；MeshbotConfigService 由全局 MeshbotConfigModule 提供，无需额外 imports，参照其它 controller 怎么注入 @meshbot/agent 的 service）。
- [ ] **Step 6: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/server-agent
git add apps/server-agent/src/controllers/artifact.controller.ts apps/server-agent/src/controllers/artifact.controller.spec.ts apps/server-agent/src/app.module.ts
git commit -m "feat(server-agent): 产物文件 serving 端点（账号作用域 + 防遍历）"
```

---

## Task 4: web-agent — artifact 纯函数（类型分发 + URL）

**Files:** Create `apps/web-agent/src/lib/artifact.ts` + `artifact.spec.ts`

**Interfaces:** Produces `artifactKind(path): 'html'|'pdf'|'image'|'markdown'|'text'|'binary'`；`artifactRawUrl(path, opts?): string`。

- [ ] **Step 1: 写失败单测** — `apps/web-agent/src/lib/artifact.spec.ts`：

```ts
import { artifactKind, artifactRawUrl } from "./artifact";

describe("artifactKind", () => {
  it("按扩展名分发", () => {
    expect(artifactKind("a.html")).toBe("html");
    expect(artifactKind("a.pdf")).toBe("pdf");
    expect(artifactKind("a.PNG")).toBe("image");
    expect(artifactKind("a.svg")).toBe("image");
    expect(artifactKind("a.md")).toBe("markdown");
    expect(artifactKind("a.csv")).toBe("text");
    expect(artifactKind("a.json")).toBe("text");
    expect(artifactKind("a.zip")).toBe("binary");
    expect(artifactKind("noext")).toBe("binary");
  });
});

describe("artifactRawUrl", () => {
  it("构造 serving URL（path 编码）", () => {
    expect(artifactRawUrl("sub dir/report.html")).toBe(
      "/api/artifacts/raw?path=sub%20dir%2Freport.html",
    );
  });
  it("download 选项", () => {
    expect(artifactRawUrl("a.md", { download: true })).toBe(
      "/api/artifacts/raw?path=a.md&download=1",
    );
  });
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm test -- apps/web-agent/src/lib/artifact.spec.ts`（FAIL）。
- [ ] **Step 3: 实现** — `apps/web-agent/src/lib/artifact.ts`：

```ts
export type ArtifactKind =
  | "html"
  | "pdf"
  | "image"
  | "markdown"
  | "text"
  | "binary";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const TEXT_EXTS = new Set([
  ".txt",
  ".csv",
  ".json",
  ".log",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".yml",
  ".yaml",
  ".xml",
]);

/** 按扩展名判定产物预览类型。 */
export function artifactKind(filePath: string): ArtifactKind {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}

/** 构造产物 serving URL（相对，同源）。 */
export function artifactRawUrl(
  filePath: string,
  opts?: { download?: boolean },
): string {
  const base = `/api/artifacts/raw?path=${encodeURIComponent(filePath)}`;
  return opts?.download ? `${base}&download=1` : base;
}
```

- [ ] **Step 4: 跑通过 + typecheck + 提交**

```bash
pnpm test -- apps/web-agent/src/lib/artifact.spec.ts
pnpm turbo typecheck --filter=@meshbot/web-agent
git add apps/web-agent/src/lib/artifact.ts apps/web-agent/src/lib/artifact.spec.ts
git commit -m "feat(web-agent): 产物类型分发 + serving URL 纯函数"
```

---

## Task 5: web-agent — atom + 文件框 + tool-call 特判

**Files:** Modify `apps/web-agent/src/atoms/assistant-panel.ts`、`apps/web-agent/src/components/session/tool-call-block.tsx`、`apps/web-agent/src/lib/tool-display.ts`；Create `apps/web-agent/src/components/session/artifact-file-card.tsx`

**Interfaces:** Consumes `artifactKind`（Task 4）、`PresentFileInput`（取 args 的 `{path, title}`）、`ToolCallView`。Produces `assistantPanelTypeAtom`、`previewArtifactAtom`、`PreviewArtifact` 类型、`ArtifactFileCard`。

- [ ] **Step 1: atom** — `atoms/assistant-panel.ts` 末尾加（先 `rg -n "atom\(" apps/web-agent/src/atoms/assistant-panel.ts` 看风格）：

```ts
/** 右侧面板当前内容：助手 or 产物预览。 */
export const assistantPanelTypeAtom = atom<"assistant" | "preview">("assistant");

/** 当前预览的产物（相对 workspace 路径 + 标题）。 */
export interface PreviewArtifact {
  path: string;
  title?: string;
}
export const previewArtifactAtom = atom<PreviewArtifact | null>(null);
```

（若文件未 import `atom`，加 `import { atom } from "jotai";`——多数已有。）

- [ ] **Step 2: TOOL_LABELS** — `lib/tool-display.ts` 的 `TOOL_LABELS` 加一行 `present_file: "呈现文件",`。

- [ ] **Step 3: ArtifactFileCard** — 创建 `components/session/artifact-file-card.tsx`：

```tsx
"use client";

import { useSetAtom } from "jotai";
import { FileText } from "lucide-react";
import {
  assistantPanelOpenAtom,
  assistantPanelTypeAtom,
  previewArtifactAtom,
} from "@/atoms/assistant-panel";
import { artifactKind } from "@/lib/artifact";
import type { ToolCallView } from "./message-list";

const KIND_LABEL: Record<string, string> = {
  html: "网页",
  pdf: "PDF",
  image: "图片",
  markdown: "Markdown",
  text: "文本",
  binary: "文件",
};

/** present_file 的对话流文件框：点击在右侧 dock 打开预览。 */
export function ArtifactFileCard({ tool }: { tool: ToolCallView }) {
  const setType = useSetAtom(assistantPanelTypeAtom);
  const setArtifact = useSetAtom(previewArtifactAtom);
  const setOpen = useSetAtom(assistantPanelOpenAtom);

  const args = (tool.args ?? {}) as { path?: string; title?: string };
  const path = args.path ?? "";
  const name = args.title ?? path.split("/").pop() ?? "文件";
  const kind = artifactKind(path);

  const open = () => {
    if (!path) return;
    setArtifact({ path, title: args.title });
    setType("preview");
    setOpen(true);
  };

  return (
    <button
      type="button"
      onClick={open}
      className="flex w-full items-center gap-3 rounded-[8px] border border-border bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-(--shell-accent)/12 text-(--shell-accent)">
        <FileText className="h-4.5 w-4.5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">
          {KIND_LABEL[kind]} · 点击预览
        </span>
      </span>
    </button>
  );
}
```

- [ ] **Step 4: tool-call-block 特判** — `tool-call-block.tsx`：import `ArtifactFileCard`，在现有 `todo_write` 特判**之后**加（仍在 `useState(open)` 之后）：

```tsx
  if (tool.name === "present_file" && tool.status !== "streaming") {
    return <ArtifactFileCard tool={tool} />;
  }
```

- [ ] **Step 5: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/web-agent
git add apps/web-agent/src/atoms/assistant-panel.ts apps/web-agent/src/lib/tool-display.ts apps/web-agent/src/components/session/artifact-file-card.tsx apps/web-agent/src/components/session/tool-call-block.tsx
git commit -m "feat(web-agent): 产物文件框 + panelType atom + tool-call 特判"
```

---

## Task 6: web-agent — 预览面板 + 全屏 + dock 切换

**Files:** Create `apps/web-agent/src/components/artifact/artifact-body.tsx`、`apps/web-agent/src/components/artifact/artifact-preview-panel.tsx`、`apps/web-agent/src/components/artifact/artifact-fullscreen.tsx`；Modify `apps/web-agent/src/components/layouts/app-shell-layout.tsx`

> `ArtifactBody`（内容分发）单独成 `artifact-body.tsx`，preview-panel 和 fullscreen 都 import 它，避免两者循环依赖。

**Interfaces:** Consumes `artifactKind`/`artifactRawUrl`（Task 4）、`assistantPanelTypeAtom`/`previewArtifactAtom`（Task 5）、`MarkdownContent`（`@/components/session/markdown-content`，**先 read 该文件确认 props 名**）。

- [ ] **Step 1: 内容分发组件** — 创建 `components/artifact/artifact-preview-panel.tsx`。先 `rg -n "export" apps/web-agent/src/components/session/markdown-content.tsx` 确认 MarkdownContent 的导出名与 props（下方按 `content` prop 写，若实际不同则改）：

```tsx
"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Download, Maximize2, Share2, X } from "lucide-react";
import { useState } from "react";
import {
  assistantPanelTypeAtom,
  previewArtifactAtom,
} from "@/atoms/assistant-panel";
import { artifactRawUrl } from "@/lib/artifact";
import { ArtifactBody } from "./artifact-body";
import { ArtifactFullscreen } from "./artifact-fullscreen";

/** 产物预览面板（dock 区域，与助手切换）。 */
export function ArtifactPreviewPanel() {
  const artifact = useAtomValue(previewArtifactAtom);
  const setType = useSetAtom(assistantPanelTypeAtom);
  const [full, setFull] = useState(false);

  if (!artifact) {
    return null;
  }
  const title = artifact.title ?? artifact.path.split("/").pop() ?? "预览";

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3.5">
        <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-foreground">
          {title}
        </span>
        <a
          href={artifactRawUrl(artifact.path, { download: true })}
          download
          title="下载"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
        <button
          type="button"
          onClick={() => setFull(true)}
          title="全屏"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled
          title="分享（即将上线）"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/40"
        >
          <Share2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setType("assistant")}
          title="关闭"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ArtifactBody path={artifact.path} />
      </div>
      {full && (
        <ArtifactFullscreen path={artifact.path} title={title} onClose={() => setFull(false)} />
      )}
    </div>
  );
}
```

- [ ] **Step 1b: ArtifactBody 内容分发（独立文件，避免 preview/fullscreen 循环依赖）** — 创建 `components/artifact/artifact-body.tsx`。先 `rg -n "export" apps/web-agent/src/components/session/markdown-content.tsx` 确认 MarkdownContent 的导出名与 props（下方按 `content` prop 写，若不同则改）：

```tsx
"use client";

import { useEffect, useState } from "react";
import { MarkdownContent } from "@/components/session/markdown-content";
import { artifactKind, artifactRawUrl } from "@/lib/artifact";

/** 按类型分发渲染产物内容（preview 面板与全屏共用）。 */
export function ArtifactBody({ path }: { path: string }) {
  const kind = artifactKind(path);
  const url = artifactRawUrl(path);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (kind !== "markdown" && kind !== "text") return;
    let cancelled = false;
    setText(null);
    setErr(false);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch(() => {
        if (!cancelled) setErr(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, url]);

  if (err) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        产物已不存在或已变更
      </div>
    );
  }
  if (kind === "html" || kind === "pdf") {
    return (
      <iframe
        title="产物预览"
        src={url}
        sandbox={kind === "html" ? "" : undefined}
        className="h-full w-full border-0 bg-white"
      />
    );
  }
  if (kind === "image") {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <img src={url} alt="产物" className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  if (kind === "markdown") {
    return (
      <div className="px-4 py-3 text-sm">
        {text === null ? (
          <span className="text-muted-foreground">加载中…</span>
        ) : (
          <MarkdownContent content={text} />
        )}
      </div>
    );
  }
  if (kind === "text") {
    return (
      <pre className="overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
        {text ?? "加载中…"}
      </pre>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
      该类型不支持预览，请下载查看。
    </div>
  );
}
```

- [ ] **Step 2: 全屏模态** — 创建 `components/artifact/artifact-fullscreen.tsx`（复用 ConfirmDialog 的 createPortal 范式，先 `rg -n "createPortal|Escape" apps/web-agent/src/components/common/confirm-dialog.tsx`）：

```tsx
"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ArtifactBody } from "./artifact-body";

/** 产物全屏预览（覆盖整屏，Esc / 点关闭退出）。 */
export function ArtifactFullscreen({
  path,
  title,
  onClose,
}: {
  path: string;
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3.5">
        <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-foreground">
          {title}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="退出全屏"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ArtifactBody path={path} />
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 3: app-shell-layout aside 切换** — `app-shell-layout.tsx` 右侧 aside 内 `<AssistantDock />`（约 line 212）改为按 panelType 切换。先 `rg -n "AssistantDock" apps/web-agent/src/components/layouts/app-shell-layout.tsx` 定位，import `ArtifactPreviewPanel` + `assistantPanelTypeAtom`/`previewArtifactAtom`，在组件体取 `const panelType = useAtomValue(assistantPanelTypeAtom)` + `const previewArtifact = useAtomValue(previewArtifactAtom)`，渲染处改：

```tsx
{panelType === "preview" && previewArtifact ? (
  <ArtifactPreviewPanel />
) : (
  <AssistantDock />
)}
```

（`useAtomValue` 多半已 import；缺则补 `import { useAtomValue } from "jotai";`。）

- [ ] **Step 4: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/web-agent
git add apps/web-agent/src/components/artifact/ apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "feat(web-agent): 产物预览面板 + 全屏 + dock 助手↔预览切换"
```

---

## Task 7: 集成验证（boot + 全量 + 围栏）

> Task 3 新增 controller（DI 变更）。按铁律真启 server-agent 验证。

- [ ] **Step 1: 全包 typecheck** — `pnpm typecheck`，全绿。
- [ ] **Step 2: 全量 jest** — `pnpm test`：新增 present-file/artifact 单测绿；2 个失败套件仍是预存在基线（session.e2e、use-global-events.spec），零新增。
- [ ] **Step 3: libs/agent vitest** — `cd libs/agent && npx vitest run`：9 基线不变 + 新 present-file.tool.test 绿。
- [ ] **Step 4: 真启 server-agent（关键）** — `pnpm dev:server-agent`：无 DI 报错、启动 successfully started + 监听 3100、`Mapped {/api/artifacts/raw, GET}` 出现。确认后停。
- [ ] **Step 5: 静态围栏** — `pnpm check`，exit 0（tx-fence `conversation.service.ts:280` 预存在 unchanged=1）。
- [ ] **Step 6: 手动冒烟（可选）** — 让 agent 写一个 report.html 并调 present_file → 对话流出现文件框 → 点击右侧出现预览（助手切走）→ 下载/全屏/关闭回助手；另测 md/图片/不存在文件（显示「已变更」）。

---

## Self-Review（已核对）

- **Spec 覆盖**：§3 present_file（Task 2）；§4 文件框特判（Task 5）；§5 panelType 切换（Task 5 atom + Task 6 layout）；§6 serving 端点（Task 3）；§7 类型分发渲染 + 全屏 + 下载 + 分享占位（Task 4 纯函数 + Task 6 面板/全屏）；§8 边界（实时读 404→「已变更」Task 6、账号作用域 + 遍历防护 Task 3、html sandbox Task 6、TOOL_LABELS Task 5）；§9 测试（各 Task TDD + Task 7 boot）。
- **零消息字段**：present_file 走 tool-call 特判（Task 5），无 SessionMessage/socket 改动——全计划未触碰这些文件。
- **类型一致**：`presentFileSchema`/`PresentFileInput`（Task 1）→ 工具（Task 2）→ 文件框读 `tool.args.{path,title}`（Task 5）；工具返回相对 `path`（Task 2）→ 文件框/预览/serving 用相对路径（Task 5/6/Task 3）；`artifactKind`/`artifactRawUrl`（Task 4）→ 文件框/预览（Task 5/6）；`assistantPanelTypeAtom`/`previewArtifactAtom`/`PreviewArtifact`（Task 5）→ 预览面板/layout（Task 6）；serving 路由 `/api/artifacts/raw`（Task 3）== `artifactRawUrl` 构造（Task 4）。
- **占位符**：无 TBD；每代码步完整代码 + 命令。两处「先 read 确认」（MarkdownContent props、各 rg 定位）是真实集成点核对，非占位。
