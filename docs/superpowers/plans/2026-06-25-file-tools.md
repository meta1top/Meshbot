# 助手文件读写编辑能力 实施计划（Read / Write / Edit / Grep / Glob + 流式实时预览）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给本地 agent 加 5 个文件工具（read_file/write_file/edit_file/grep/glob）+ 新鲜度安全追踪 + LLM 生成 tool_call 参数时的前端实时"打字"预览。

**Architecture:** 5 个 `@Tool()` 类落 `libs/agent/src/tools/builtins/`，复用 `BashTool` 范式（`ToolContext` / `MeshbotConfigService` / 32KB 截断）。新增 `FileStateService` 内存追踪 read-before-write 新鲜度。流式预览新增一条瞬态事件 `run.tool_call_args_delta`：graph 层捕获 `AIMessageChunk.tool_call_chunks` → runner emit → gateway 转发 → 前端尽力部分解析 args JSON 逐字渲染。

**Tech Stack:** NestJS / LangGraph / Zod / vitest（libs/agent）/ jest（web-common）/ Next.js（web-agent）/ `@vscode/ripgrep` / `fast-glob` / `best-effort-json-parser`。

## Global Constraints

- **设计文档**：`docs/superpowers/specs/2026-06-25-file-read-write-edit-tools-design.md`（本计划的事实来源）。
- **当前分支**：`feat/file-tools`（已存在，所有提交落此分支）。
- **工具命名**：snake_case —— `read_file` / `write_file` / `edit_file` / `grep` / `glob`。
- **编辑定位**：字符串精确匹配，**不靠行号**；行号仅用于展示，在 Node 进程内计算。
- **路径范围**：全文件系统访问。绝对路径直用；相对路径对 `MeshbotConfigService.getWorkspaceDir()` 解析。**不做沙箱黑名单**。
- **写入**：原子写（同目录临时文件 + `fs.rename`）。覆写/编辑已存在文件前必须本会话 `read_file` 过且 mtime+size 未变。
- **测试命令**：libs/agent → `pnpm --filter @meshbot/agent test <path>`（vitest，import 用 `.js` 后缀）；web-common → `pnpm --filter @meshbot/web-common test -- <path>`（jest，`.spec.ts`）。
- **提交前**：`pnpm check`（7 道静态围栏）。`FileStateService` 无 Entity/Repository/装饰器，围栏自然通过。
- **中文 JSDoc**：公开方法/类加中文注释（项目约定）。
- **禁止**在 `if` 前一行单独放注释（Biome 会破坏结构）。

---

## Phase 1 — 五个工具 + 安全模型（不含流式预览）

### Task 1: 路径工具 + FileStateService（新鲜度追踪）

**Files:**
- Create: `libs/agent/src/tools/builtins/file-path.util.ts`
- Create: `libs/agent/src/tools/builtins/file-state.service.ts`
- Test: `libs/agent/tests/unit/file-state.service.test.ts`
- Modify: `libs/agent/src/agent.module.ts`（注册 `FileStateService`）

**Interfaces:**
- Produces:
  - `resolveFilePath(filePath: string, workspaceDir: string): string`
  - `interface FileStat { mtimeMs: number; size: number }`
  - `class FileStateService`：`recordRead(sessionId, absPath, stat)` / `recordWrite(sessionId, absPath, stat)` / `assertFresh(sessionId, absPath, current: FileStat): void`（不新鲜抛 Error）/ `clearSession(sessionId)`

- [ ] **Step 1: 写 file-path.util.ts**

```typescript
import path from "node:path";

/** 绝对路径直接 normalize；相对路径对 workspaceDir 解析。 */
export function resolveFilePath(filePath: string, workspaceDir: string): string {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(workspaceDir, filePath);
}
```

- [ ] **Step 2: 写失败测试 file-state.service.test.ts**

```typescript
import { describe, expect, it } from "vitest";
import { FileStateService } from "../../src/tools/builtins/file-state.service.js";

describe("FileStateService", () => {
  it("未读过的文件 assertFresh 抛错", () => {
    const s = new FileStateService();
    expect(() => s.assertFresh("sess", "/a.txt", { mtimeMs: 1, size: 1 })).toThrow();
  });

  it("read 后同 mtime+size 通过", () => {
    const s = new FileStateService();
    s.recordRead("sess", "/a.txt", { mtimeMs: 100, size: 10 });
    expect(() => s.assertFresh("sess", "/a.txt", { mtimeMs: 100, size: 10 })).not.toThrow();
  });

  it("read 后 size 变化 → 抛错（外部改动）", () => {
    const s = new FileStateService();
    s.recordRead("sess", "/a.txt", { mtimeMs: 100, size: 10 });
    expect(() => s.assertFresh("sess", "/a.txt", { mtimeMs: 100, size: 20 })).toThrow();
  });

  it("会话隔离：另一会话读过不算", () => {
    const s = new FileStateService();
    s.recordRead("sess-A", "/a.txt", { mtimeMs: 1, size: 1 });
    expect(() => s.assertFresh("sess-B", "/a.txt", { mtimeMs: 1, size: 1 })).toThrow();
  });

  it("clearSession 后再 assert 抛错", () => {
    const s = new FileStateService();
    s.recordRead("sess", "/a.txt", { mtimeMs: 1, size: 1 });
    s.clearSession("sess");
    expect(() => s.assertFresh("sess", "/a.txt", { mtimeMs: 1, size: 1 })).toThrow();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @meshbot/agent test tests/unit/file-state.service.test.ts`
Expected: FAIL（`file-state.service` 模块不存在）

- [ ] **Step 4: 写 file-state.service.ts**

```typescript
import { Injectable } from "@nestjs/common";

/** 文件新鲜度基线（mtime + size）。 */
export interface FileStat {
  mtimeMs: number;
  size: number;
}

/** 防内存无界增长的上限；超过按插入序 FIFO 驱逐。 */
const MAX_ENTRIES = 5000;

/**
 * 按 (sessionId, absPath) 追踪文件最近一次 read/write 的 mtime+size，
 * 支撑「改/覆写前必须先 read 且未被外部改动」铁律。纯内存、无 Repository。
 */
@Injectable()
export class FileStateService {
  private readonly states = new Map<string, FileStat>();

  private key(sessionId: string, absPath: string): string {
    return `${sessionId}::${absPath}`;
  }

  private set(k: string, stat: FileStat): void {
    if (!this.states.has(k) && this.states.size >= MAX_ENTRIES) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    this.states.set(k, { mtimeMs: stat.mtimeMs, size: stat.size });
  }

  /** read_file 后记录基线。 */
  recordRead(sessionId: string, absPath: string, stat: FileStat): void {
    this.set(this.key(sessionId, absPath), stat);
  }

  /** write/edit 后刷新基线（避免随后的 edit 误判过期）。 */
  recordWrite(sessionId: string, absPath: string, stat: FileStat): void {
    this.set(this.key(sessionId, absPath), stat);
  }

  /** 校验文件自上次 read/write 后未被外部改动；未读过或已变 → 抛错。 */
  assertFresh(sessionId: string, absPath: string, current: FileStat): void {
    const known = this.states.get(this.key(sessionId, absPath));
    if (!known) {
      throw new Error(
        `file not read this session — call read_file on ${absPath} before editing/overwriting`,
      );
    }
    if (known.mtimeMs !== current.mtimeMs || known.size !== current.size) {
      throw new Error(
        `file ${absPath} changed on disk since last read — call read_file again before editing/overwriting`,
      );
    }
  }

  /** 会话销毁时清掉该会话所有记录。 */
  clearSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const k of this.states.keys()) {
      if (k.startsWith(prefix)) this.states.delete(k);
    }
  }
}
```

- [ ] **Step 5: 注册到 AgentModule**

在 `libs/agent/src/agent.module.ts` providers 顶部加入（import + provider）：

```typescript
import { FileStateService } from "./tools/builtins/file-state.service";
```

providers 数组里（`ToolRegistry,` 之后）加：

```typescript
    FileStateService,
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @meshbot/agent test tests/unit/file-state.service.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 7: Commit**

```bash
git add libs/agent/src/tools/builtins/file-path.util.ts libs/agent/src/tools/builtins/file-state.service.ts libs/agent/tests/unit/file-state.service.test.ts libs/agent/src/agent.module.ts
git commit -m "feat(agent): FileStateService 新鲜度追踪 + 路径解析工具"
```

---

### Task 2: read_file 工具

**Files:**
- Create: `libs/agent/src/tools/builtins/read-file.tool.ts`
- Test: `libs/agent/tests/unit/read-file.tool.test.ts`
- Modify: `libs/agent/src/agent.module.ts`

**Interfaces:**
- Consumes: `resolveFilePath`、`FileStateService`（Task 1）、`MeshbotConfigService.getWorkspaceDir()`、`MeshbotTool` / `ToolContext`。
- Produces: `class ReadFileTool`（name=`read_file`），cat -n 输出；副作用 `fileState.recordRead`。

- [ ] **Step 1: 写失败测试 read-file.tool.test.ts**

测试构造 tool 时直接 new（绕过 DI），传入一个最小 config stub 和真实 `FileStateService`。`ctx` 用最小桩。

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStateService } from "../../src/tools/builtins/file-state.service.js";
import { ReadFileTool } from "../../src/tools/builtins/read-file.tool.js";
import type { ToolContext } from "../../src/tools/tool.types.js";

function makeCtx(): ToolContext {
  return {
    sessionId: "sess-1",
    messageId: "m1",
    toolCallId: "tc1",
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    emitter: { emit: () => true } as any,
    signal: new AbortController().signal,
  };
}

function makeTool(workspace: string, fileState = new FileStateService()) {
  // biome-ignore lint/suspicious/noExplicitAny: 仅用到 getWorkspaceDir
  const config = { getWorkspaceDir: () => workspace } as any;
  return { tool: new ReadFileTool(config, fileState), fileState };
}

describe("ReadFileTool", () => {
  it("输出 cat -n 行号格式", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-"));
    const f = path.join(dir, "a.txt");
    writeFileSync(f, "alpha\nbeta\ngamma");
    const { tool } = makeTool(dir);
    const out = await tool.execute({ file_path: f }, makeCtx());
    expect(out).toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  it("offset/limit 截取行窗口", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-"));
    const f = path.join(dir, "a.txt");
    writeFileSync(f, "l1\nl2\nl3\nl4\nl5");
    const { tool } = makeTool(dir);
    const out = await tool.execute({ file_path: f, offset: 2, limit: 2 }, makeCtx());
    expect(out).toBe("2\tl2\n3\tl3");
  });

  it("相对路径对 workspace 解析", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-"));
    writeFileSync(path.join(dir, "rel.txt"), "x");
    const { tool } = makeTool(dir);
    const out = await tool.execute({ file_path: "rel.txt" }, makeCtx());
    expect(out).toBe("1\tx");
  });

  it("二进制文件报错", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-"));
    const f = path.join(dir, "bin");
    writeFileSync(f, Buffer.from([0x41, 0x00, 0x42]));
    const { tool } = makeTool(dir);
    const out = await tool.execute({ file_path: f }, makeCtx());
    expect(out).toContain("binary");
  });

  it("空文件返回提示", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-"));
    const f = path.join(dir, "empty.txt");
    writeFileSync(f, "");
    const { tool } = makeTool(dir);
    const out = await tool.execute({ file_path: f }, makeCtx());
    expect(out).toContain("empty");
  });

  it("不存在的文件报错且不抛", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-"));
    const { tool } = makeTool(dir);
    const out = await tool.execute({ file_path: path.join(dir, "nope.txt") }, makeCtx());
    expect(out).toContain("Error");
  });

  it("读后记录新鲜度基线（assertFresh 通过）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-"));
    const f = path.join(dir, "a.txt");
    writeFileSync(f, "hi");
    const { tool, fileState } = makeTool(dir);
    await tool.execute({ file_path: f }, makeCtx());
    const { statSync } = await import("node:fs");
    expect(() => fileState.assertFresh("sess-1", f, statSync(f))).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meshbot/agent test tests/unit/read-file.tool.test.ts`
Expected: FAIL（`read-file.tool` 不存在）

- [ ] **Step 3: 写 read-file.tool.ts**

```typescript
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { resolveFilePath } from "./file-path.util";
import { FileStateService } from "./file-state.service";

const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;

const ReadArgsSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path, or relative to the workspace directory."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based start line. Default 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Max lines to read. Default ${DEFAULT_LIMIT}.`),
});
type ReadArgs = z.infer<typeof ReadArgsSchema>;

/** 读文本文件并以 cat -n（行号 + Tab + 内容）返回。读后记录新鲜度基线。 */
@Tool()
export class ReadFileTool implements MeshbotTool<ReadArgs, string> {
  readonly name = "read_file";
  readonly description =
    "Read a text file. Returns cat -n style (line number + tab + content). " +
    "Use offset/limit for large files. You MUST read a file before editing or overwriting it.";
  readonly schema = ReadArgsSchema;

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly fileState: FileStateService,
  ) {}

  async execute(args: ReadArgs, ctx: ToolContext): Promise<string> {
    const abs = resolveFilePath(args.file_path, this.config.getWorkspaceDir());
    let raw: Buffer;
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(abs);
      raw = readFileSync(abs);
    } catch {
      return `Error: cannot read ${abs} (not found or not accessible)`;
    }
    if (isBinary(raw)) {
      return `Error: ${abs} appears to be a binary file; refusing to read as text`;
    }
    this.fileState.recordRead(ctx.sessionId, abs, stat);
    const text = raw.toString("utf8");
    if (text.length === 0) return `(file ${abs} is empty)`;
    return formatNumbered(text, args.offset ?? 1, args.limit ?? DEFAULT_LIMIT);
  }
}

/** 探测前 8KB 是否含 NUL 字节，有则视作二进制。 */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** 从 offset 起取 limit 行，按 cat -n 渲染，单行超 MAX_LINE 截断。 */
function formatNumbered(text: string, offset: number, limit: number): string {
  const lines = text.split("\n");
  const start = offset - 1;
  const slice = lines.slice(start, start + limit);
  const width = String(start + slice.length).length;
  return slice
    .map((line, i) => {
      const n = String(start + i + 1).padStart(width, " ");
      const body =
        line.length > MAX_LINE
          ? `${line.slice(0, MAX_LINE)}… [line truncated]`
          : line;
      return `${n}\t${body}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: 注册到 AgentModule**

`agent.module.ts`：import 并把 `ReadFileTool` 加进 providers（紧跟 `BashTool,`）：

```typescript
import { ReadFileTool } from "./tools/builtins/read-file.tool";
```
```typescript
    ReadFileTool,
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @meshbot/agent test tests/unit/read-file.tool.test.ts`
Expected: PASS（7 passed）

- [ ] **Step 6: Commit**

```bash
git add libs/agent/src/tools/builtins/read-file.tool.ts libs/agent/tests/unit/read-file.tool.test.ts libs/agent/src/agent.module.ts
git commit -m "feat(agent): read_file 工具（cat -n + 新鲜度基线）"
```

---

### Task 3: write_file 工具（含原子写）

**Files:**
- Create: `libs/agent/src/tools/builtins/write-file.tool.ts`
- Test: `libs/agent/tests/unit/write-file.tool.test.ts`
- Modify: `libs/agent/src/agent.module.ts`

**Interfaces:**
- Consumes: `resolveFilePath`、`FileStateService`、`MeshbotConfigService`。
- Produces:
  - `class WriteFileTool`（name=`write_file`）
  - `atomicWrite(abs: string, content: string): void`（导出，供 edit_file 复用）

- [ ] **Step 1: 写失败测试 write-file.tool.test.ts**

```typescript
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStateService } from "../../src/tools/builtins/file-state.service.js";
import { WriteFileTool } from "../../src/tools/builtins/write-file.tool.js";
import type { ToolContext } from "../../src/tools/tool.types.js";

function makeCtx(): ToolContext {
  return {
    sessionId: "sess-1",
    messageId: "m1",
    toolCallId: "tc1",
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    emitter: { emit: () => true } as any,
    signal: new AbortController().signal,
  };
}
function makeTool(workspace: string, fileState = new FileStateService()) {
  // biome-ignore lint/suspicious/noExplicitAny: 仅用到 getWorkspaceDir
  const config = { getWorkspaceDir: () => workspace } as any;
  return { tool: new WriteFileTool(config, fileState), fileState };
}

describe("WriteFileTool", () => {
  it("新建文件（自动建父目录）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-"));
    const f = path.join(dir, "sub/deep/new.txt");
    const { tool } = makeTool(dir);
    const out = await tool.execute({ file_path: f, content: "hello\nworld" }, makeCtx());
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("hello\nworld");
    expect(out).toContain("2 line");
  });

  it("覆写已存在文件但未 read 过 → 报错且不改盘", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-"));
    const f = path.join(dir, "x.txt");
    writeFileSync(f, "original");
    const { tool } = makeTool(dir);
    const out = await tool.execute({ file_path: f, content: "new" }, makeCtx());
    expect(out).toContain("Error");
    expect(readFileSync(f, "utf8")).toBe("original");
  });

  it("read 过且未变 → 覆写成功", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-"));
    const f = path.join(dir, "x.txt");
    writeFileSync(f, "original");
    const { tool, fileState } = makeTool(dir);
    fileState.recordRead("sess-1", f, statSync(f));
    const out = await tool.execute({ file_path: f, content: "new" }, makeCtx());
    expect(out).toContain("Wrote");
    expect(readFileSync(f, "utf8")).toBe("new");
  });

  it("read 后文件被外部改动（size 变）→ 报错", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-"));
    const f = path.join(dir, "x.txt");
    writeFileSync(f, "aaa");
    const { tool, fileState } = makeTool(dir);
    fileState.recordRead("sess-1", f, statSync(f));
    writeFileSync(f, "aaaaaaaaaa"); // size 变化 → 过期
    const out = await tool.execute({ file_path: f, content: "new" }, makeCtx());
    expect(out).toContain("changed on disk");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meshbot/agent test tests/unit/write-file.tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 write-file.tool.ts**

```typescript
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { resolveFilePath } from "./file-path.util";
import { FileStateService } from "./file-state.service";

const WriteArgsSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path, or relative to the workspace directory."),
  content: z.string().describe("Full file content to write."),
});
type WriteArgs = z.infer<typeof WriteArgsSchema>;

/** 原子写文件：创建或覆写。覆写已存在文件前要求本会话 read 过且未被改动。 */
@Tool()
export class WriteFileTool implements MeshbotTool<WriteArgs, string> {
  readonly name = "write_file";
  readonly description =
    "Write (create or overwrite) a text file with the given content. " +
    "Overwriting an existing file requires you to have read it first this session. " +
    "Creates parent directories as needed.";
  readonly schema = WriteArgsSchema;

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly fileState: FileStateService,
  ) {}

  async execute(args: WriteArgs, ctx: ToolContext): Promise<string> {
    const abs = resolveFilePath(args.file_path, this.config.getWorkspaceDir());
    if (existsSync(abs)) {
      try {
        this.fileState.assertFresh(ctx.sessionId, abs, statSync(abs));
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    try {
      atomicWrite(abs, args.content);
    } catch (err) {
      return `Error: cannot write ${abs}: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.fileState.recordWrite(ctx.sessionId, abs, statSync(abs));
    const lineCount = args.content === "" ? 0 : args.content.split("\n").length;
    return `Wrote ${lineCount} line(s) to ${abs}`;
  }
}

let tmpSeq = 0;

/** 原子写：同目录临时文件 + rename（同盘原子），杜绝半成品文件。 */
export function atomicWrite(abs: string, content: string): void {
  const dir = path.dirname(abs);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${tmpSeq++}.tmp`);
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, abs);
}
```

- [ ] **Step 4: 注册到 AgentModule**

```typescript
import { WriteFileTool } from "./tools/builtins/write-file.tool";
```
```typescript
    WriteFileTool,
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @meshbot/agent test tests/unit/write-file.tool.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 6: Commit**

```bash
git add libs/agent/src/tools/builtins/write-file.tool.ts libs/agent/tests/unit/write-file.tool.test.ts libs/agent/src/agent.module.ts
git commit -m "feat(agent): write_file 工具（原子写 + 新鲜度铁律）"
```

---

### Task 4: edit_file 工具

**Files:**
- Create: `libs/agent/src/tools/builtins/edit-file.tool.ts`
- Test: `libs/agent/tests/unit/edit-file.tool.test.ts`
- Modify: `libs/agent/src/agent.module.ts`

**Interfaces:**
- Consumes: `resolveFilePath`、`FileStateService`、`MeshbotConfigService`、`atomicWrite`（Task 3）。
- Produces: `class EditFileTool`（name=`edit_file`），返回带 cat -n 行号的编辑后片段。

- [ ] **Step 1: 写失败测试 edit-file.tool.test.ts**

```typescript
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EditFileTool } from "../../src/tools/builtins/edit-file.tool.js";
import { FileStateService } from "../../src/tools/builtins/file-state.service.js";
import type { ToolContext } from "../../src/tools/tool.types.js";

function makeCtx(): ToolContext {
  return {
    sessionId: "sess-1",
    messageId: "m1",
    toolCallId: "tc1",
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    emitter: { emit: () => true } as any,
    signal: new AbortController().signal,
  };
}
function setup(content: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "ef-"));
  const f = path.join(dir, "code.txt");
  writeFileSync(f, content);
  const fileState = new FileStateService();
  fileState.recordRead("sess-1", f, statSync(f));
  // biome-ignore lint/suspicious/noExplicitAny: 仅用到 getWorkspaceDir
  const config = { getWorkspaceDir: () => dir } as any;
  return { tool: new EditFileTool(config, fileState), f, dir, fileState };
}

describe("EditFileTool", () => {
  it("唯一命中 → 替换并返回行号片段", async () => {
    const { tool, f } = setup("line1\nfoo\nline3");
    const out = await tool.execute(
      { file_path: f, old_string: "foo", new_string: "bar" },
      makeCtx(),
    );
    expect(readFileSync(f, "utf8")).toBe("line1\nbar\nline3");
    expect(out).toContain("2\tbar");
  });

  it("0 命中 → 报错", async () => {
    const { tool, f } = setup("abc");
    const out = await tool.execute(
      { file_path: f, old_string: "zzz", new_string: "x" },
      makeCtx(),
    );
    expect(out).toContain("not found");
  });

  it("多命中且无 replace_all → 报错", async () => {
    const { tool, f } = setup("x\nx\nx");
    const out = await tool.execute(
      { file_path: f, old_string: "x", new_string: "y" },
      makeCtx(),
    );
    expect(out).toContain("matches 3 times");
  });

  it("replace_all 替换全部", async () => {
    const { tool, f } = setup("x\nx\nx");
    await tool.execute(
      { file_path: f, old_string: "x", new_string: "y", replace_all: true },
      makeCtx(),
    );
    expect(readFileSync(f, "utf8")).toBe("y\ny\ny");
  });

  it("old == new → 报错", async () => {
    const { tool, f } = setup("a");
    const out = await tool.execute(
      { file_path: f, old_string: "a", new_string: "a" },
      makeCtx(),
    );
    expect(out).toContain("identical");
  });

  it("new_string 含 $& 按字面替换（不做正则展开）", async () => {
    const { tool, f } = setup("foo");
    await tool.execute(
      { file_path: f, old_string: "foo", new_string: "$& and $1" },
      makeCtx(),
    );
    expect(readFileSync(f, "utf8")).toBe("$& and $1");
  });

  it("未 read 过 → 报错", async () => {
    const { tool, f, fileState } = setup("hello");
    fileState.clearSession("sess-1");
    const out = await tool.execute(
      { file_path: f, old_string: "hello", new_string: "hi" },
      makeCtx(),
    );
    expect(out).toContain("not read this session");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meshbot/agent test tests/unit/edit-file.tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 edit-file.tool.ts**

```typescript
import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { resolveFilePath } from "./file-path.util";
import { FileStateService } from "./file-state.service";
import { atomicWrite } from "./write-file.tool";

const CONTEXT_LINES = 3;

const EditArgsSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path, or relative to the workspace directory."),
  old_string: z
    .string()
    .describe("Exact text to replace. Must match uniquely unless replace_all is set."),
  new_string: z.string().describe("Replacement text. Must differ from old_string."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace every occurrence. Default false."),
});
type EditArgs = z.infer<typeof EditArgsSchema>;

/** 字符串精确匹配替换。要求本会话 read 过且未被改动。返回编辑后行号片段。 */
@Tool()
export class EditFileTool implements MeshbotTool<EditArgs, string> {
  readonly name = "edit_file";
  readonly description =
    "Replace an exact string in a file. old_string must match uniquely " +
    "(or set replace_all=true). Requires you to have read the file first this session. " +
    "Returns a line-numbered snippet of the edited region.";
  readonly schema = EditArgsSchema;

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly fileState: FileStateService,
  ) {}

  async execute(args: EditArgs, ctx: ToolContext): Promise<string> {
    const abs = resolveFilePath(args.file_path, this.config.getWorkspaceDir());
    if (args.old_string === args.new_string) {
      return "Error: old_string and new_string are identical";
    }
    if (!existsSync(abs)) return `Error: ${abs} does not exist`;
    try {
      this.fileState.assertFresh(ctx.sessionId, abs, statSync(abs));
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const original = readFileSync(abs, "utf8");
    const count = countOccurrences(original, args.old_string);
    if (count === 0) return `Error: old_string not found in ${abs}`;
    if (count > 1 && !args.replace_all) {
      return `Error: old_string matches ${count} times in ${abs}; add more context to make it unique, or set replace_all=true`;
    }
    const updated = args.replace_all
      ? original.split(args.old_string).join(args.new_string)
      : original.replace(args.old_string, () => args.new_string);
    atomicWrite(abs, updated);
    this.fileState.recordWrite(ctx.sessionId, abs, statSync(abs));
    const n = args.replace_all ? count : 1;
    return `Edited ${abs} (${n} replacement(s))\n\n${snippetAround(updated, args.new_string)}`;
  }
}

/** 数全部非重叠出现次数。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** 定位 marker 首次出现所在行，输出其 ± CONTEXT_LINES 行的 cat -n 片段。 */
function snippetAround(text: string, marker: string): string {
  const idx = marker === "" ? -1 : text.indexOf(marker);
  const markerLine = (idx < 0 ? text : text.slice(0, idx)).split("\n").length;
  const lines = text.split("\n");
  const start = Math.max(0, markerLine - 1 - CONTEXT_LINES);
  const end = Math.min(lines.length, markerLine + CONTEXT_LINES);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    out.push(`${String(i + 1).padStart(width, " ")}\t${lines[i]}`);
  }
  return out.join("\n");
}
```

- [ ] **Step 4: 注册到 AgentModule**

```typescript
import { EditFileTool } from "./tools/builtins/edit-file.tool";
```
```typescript
    EditFileTool,
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @meshbot/agent test tests/unit/edit-file.tool.test.ts`
Expected: PASS（7 passed）

- [ ] **Step 6: Commit**

```bash
git add libs/agent/src/tools/builtins/edit-file.tool.ts libs/agent/tests/unit/edit-file.tool.test.ts libs/agent/src/agent.module.ts
git commit -m "feat(agent): edit_file 工具（字符串精确匹配 + 行号片段）"
```

---

### Task 5: grep 工具（ripgrep）

**Files:**
- Create: `libs/agent/src/tools/builtins/grep.tool.ts`
- Test: `libs/agent/tests/unit/grep.tool.test.ts`
- Modify: `libs/agent/src/agent.module.ts`、`libs/agent/package.json`

**Interfaces:**
- Consumes: `MeshbotConfigService`、`@vscode/ripgrep` 的 `rgPath`。
- Produces:
  - `buildRgArgs(args: GrepArgs): string[]`（导出，纯函数，单测核心）
  - `class GrepTool`（name=`grep`）

- [ ] **Step 1: 装依赖**

```bash
pnpm --filter @meshbot/agent add @vscode/ripgrep
```
Expected: 安装并下载平台 rg 二进制（postinstall）。确认 `libs/agent/package.json` dependencies 出现 `@vscode/ripgrep`。

- [ ] **Step 2: 写测试 grep.tool.test.ts（含 buildRgArgs 纯函数 + 一个真实搜索）**

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GrepTool, buildRgArgs } from "../../src/tools/builtins/grep.tool.js";
import type { ToolContext } from "../../src/tools/tool.types.js";

function makeCtx(): ToolContext {
  return {
    sessionId: "s",
    messageId: "m",
    toolCallId: "t",
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    emitter: { emit: () => true } as any,
    signal: new AbortController().signal,
  };
}

describe("buildRgArgs", () => {
  it("默认 files_with_matches → -l", () => {
    expect(buildRgArgs({ pattern: "foo" })).toEqual(["-l", "--", "foo", "."]);
  });
  it("content + 大小写不敏感 + context", () => {
    expect(
      buildRgArgs({ pattern: "foo", output_mode: "content", case_insensitive: true, context: 2 }),
    ).toEqual(["-n", "-i", "-C", "2", "--", "foo", "."]);
  });
  it("count 模式 → -c", () => {
    expect(buildRgArgs({ pattern: "x", output_mode: "count" })).toEqual(["-c", "--", "x", "."]);
  });
  it("glob / type / 自定义 path", () => {
    expect(
      buildRgArgs({ pattern: "x", glob: "*.ts", type: "ts", path: "src" }),
    ).toEqual(["-l", "-g", "*.ts", "-t", "ts", "--", "x", "src"]);
  });
});

describe("GrepTool 真实搜索", () => {
  it("在 workspace 里找到匹配文件", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grep-"));
    writeFileSync(path.join(dir, "a.txt"), "needle here");
    writeFileSync(path.join(dir, "b.txt"), "nothing");
    // biome-ignore lint/suspicious/noExplicitAny: 仅用到 getWorkspaceDir
    const config = { getWorkspaceDir: () => dir } as any;
    const tool = new GrepTool(config);
    const out = await tool.execute({ pattern: "needle" }, makeCtx());
    expect(out).toContain("a.txt");
    expect(out).not.toContain("b.txt");
  });

  it("无匹配返回 No matches found.", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grep-"));
    writeFileSync(path.join(dir, "a.txt"), "hello");
    // biome-ignore lint/suspicious/noExplicitAny: 仅用到 getWorkspaceDir
    const config = { getWorkspaceDir: () => dir } as any;
    const tool = new GrepTool(config);
    const out = await tool.execute({ pattern: "zzzzz" }, makeCtx());
    expect(out).toContain("No matches");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @meshbot/agent test tests/unit/grep.tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 写 grep.tool.ts**

```typescript
import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 30_000;

const GrepArgsSchema = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for."),
  path: z
    .string()
    .optional()
    .describe("File or directory to search. Default: workspace directory."),
  glob: z.string().optional().describe("Glob to filter files, e.g. '*.ts'."),
  type: z.string().optional().describe("ripgrep file type filter, e.g. 'ts'."),
  output_mode: z
    .enum(["files_with_matches", "content", "count"])
    .optional()
    .describe("files_with_matches (default) | content | count."),
  case_insensitive: z.boolean().optional().describe("Case-insensitive (-i)."),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Lines of surrounding context for content mode (-C)."),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Cap number of output lines."),
});
type GrepArgs = z.infer<typeof GrepArgsSchema>;

/** 用 ripgrep 搜索文件内容（正则）。默认遵守 .gitignore。 */
@Tool()
export class GrepTool implements MeshbotTool<GrepArgs, string> {
  readonly name = "grep";
  readonly description =
    "Search file contents with ripgrep (regular expressions). Respects .gitignore by default.";
  readonly schema = GrepArgsSchema;

  constructor(private readonly config: MeshbotConfigService) {}

  async execute(args: GrepArgs, ctx: ToolContext): Promise<string> {
    const cwd = this.config.getWorkspaceDir();
    return runRg(buildRgArgs(args), cwd, ctx.signal, args.head_limit);
  }
}

/** 把 GrepArgs 映射为 rg 命令行参数（纯函数，便于单测）。 */
export function buildRgArgs(args: GrepArgs): string[] {
  const argv: string[] = [];
  const mode = args.output_mode ?? "files_with_matches";
  if (mode === "files_with_matches") argv.push("-l");
  else if (mode === "count") argv.push("-c");
  else argv.push("-n");
  if (args.case_insensitive) argv.push("-i");
  if (mode === "content" && args.context !== undefined) {
    argv.push("-C", String(args.context));
  }
  if (args.glob) argv.push("-g", args.glob);
  if (args.type) argv.push("-t", args.type);
  argv.push("--", args.pattern);
  argv.push(args.path ?? ".");
  return argv;
}

/** spawn rg，收集 stdout，封顶 + head_limit；exit code 1（无匹配）不视作错误。 */
function runRg(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  headLimit?: number,
): Promise<string> {
  return new Promise((resolve) => {
    const buf: string[] = [];
    let len = 0;
    const child = spawn(rgPath, argv, { cwd, signal });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => {
      if (len < OUTPUT_LIMIT) {
        const s = c.toString("utf8");
        buf.push(s);
        len += s.length;
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.name === "AbortError" || err.code === "ABORT_ERR") {
        resolve("[search aborted]");
      } else {
        resolve(`Error: ripgrep failed: ${err.message}`);
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      let out = buf.join("");
      if (headLimit !== undefined) {
        out = out.split("\n").slice(0, headLimit).join("\n");
      }
      if (out.length > OUTPUT_LIMIT) {
        out = `${out.slice(0, OUTPUT_LIMIT)}\n[output truncated]`;
      }
      resolve(out.trim() === "" ? "No matches found." : out);
    });
  });
}
```

- [ ] **Step 5: 注册到 AgentModule**

```typescript
import { GrepTool } from "./tools/builtins/grep.tool";
```
```typescript
    GrepTool,
```

- [ ] **Step 6: 运行确认通过**

Run: `pnpm --filter @meshbot/agent test tests/unit/grep.tool.test.ts`
Expected: PASS（6 passed）

- [ ] **Step 7: Commit**

```bash
git add libs/agent/src/tools/builtins/grep.tool.ts libs/agent/tests/unit/grep.tool.test.ts libs/agent/src/agent.module.ts libs/agent/package.json
git commit -m "feat(agent): grep 工具（@vscode/ripgrep）"
```

---

### Task 6: glob 工具（fast-glob）

**Files:**
- Create: `libs/agent/src/tools/builtins/glob.tool.ts`
- Test: `libs/agent/tests/unit/glob.tool.test.ts`
- Modify: `libs/agent/src/agent.module.ts`、`libs/agent/package.json`

**Interfaces:**
- Consumes: `MeshbotConfigService`、`fast-glob`。
- Produces:
  - `sortByMtimeDesc(paths: string[]): string[]`（导出，纯函数，单测核心）
  - `class GlobTool`（name=`glob`）

- [ ] **Step 1: 装依赖**

```bash
pnpm --filter @meshbot/agent add fast-glob
```

- [ ] **Step 2: 写测试 glob.tool.test.ts**

```typescript
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GlobTool, sortByMtimeDesc } from "../../src/tools/builtins/glob.tool.js";
import type { ToolContext } from "../../src/tools/tool.types.js";

function makeCtx(): ToolContext {
  return {
    sessionId: "s",
    messageId: "m",
    toolCallId: "t",
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    emitter: { emit: () => true } as any,
    signal: new AbortController().signal,
  };
}

describe("sortByMtimeDesc", () => {
  it("按 mtime 倒序（最近改的在前）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glob-"));
    const older = path.join(dir, "old.txt");
    const newer = path.join(dir, "new.txt");
    writeFileSync(older, "a");
    writeFileSync(newer, "b");
    utimesSync(older, new Date(2000, 0, 1), new Date(2000, 0, 1));
    utimesSync(newer, new Date(2030, 0, 1), new Date(2030, 0, 1));
    expect(sortByMtimeDesc([older, newer])).toEqual([newer, older]);
  });
});

describe("GlobTool", () => {
  it("匹配文件并返回绝对路径", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glob-"));
    writeFileSync(path.join(dir, "a.ts"), "");
    writeFileSync(path.join(dir, "b.js"), "");
    // biome-ignore lint/suspicious/noExplicitAny: 仅用到 getWorkspaceDir
    const config = { getWorkspaceDir: () => dir } as any;
    const tool = new GlobTool(config);
    const out = await tool.execute({ pattern: "**/*.ts" }, makeCtx());
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.js");
  });

  it("无匹配返回提示", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glob-"));
    // biome-ignore lint/suspicious/noExplicitAny: 仅用到 getWorkspaceDir
    const config = { getWorkspaceDir: () => dir } as any;
    const tool = new GlobTool(config);
    const out = await tool.execute({ pattern: "**/*.zzz" }, makeCtx());
    expect(out).toContain("No files");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @meshbot/agent test tests/unit/glob.tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 写 glob.tool.ts**

```typescript
import { statSync } from "node:fs";
import fg from "fast-glob";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const RESULT_LIMIT = 1000;

const GlobArgsSchema = z.object({
  pattern: z.string().min(1).describe("Glob pattern, e.g. '**/*.ts'."),
  path: z
    .string()
    .optional()
    .describe("Base directory to search. Default: workspace directory."),
});
type GlobArgs = z.infer<typeof GlobArgsSchema>;

/** 按 glob 找文件，返回绝对路径，mtime 倒序（最近改的在前）。 */
@Tool()
export class GlobTool implements MeshbotTool<GlobArgs, string> {
  readonly name = "glob";
  readonly description =
    "Find files by glob pattern. Returns absolute paths sorted by modification time (newest first).";
  readonly schema = GlobArgsSchema;

  constructor(private readonly config: MeshbotConfigService) {}

  async execute(args: GlobArgs, _ctx: ToolContext): Promise<string> {
    const cwd = args.path ?? this.config.getWorkspaceDir();
    const matches = await fg(args.pattern, {
      cwd,
      absolute: true,
      dot: false,
      onlyFiles: true,
      suppressErrors: true,
    });
    if (matches.length === 0) return "No files matched.";
    const sorted = sortByMtimeDesc(matches).slice(0, RESULT_LIMIT);
    const more =
      matches.length > RESULT_LIMIT
        ? `\n[showing first ${RESULT_LIMIT} of ${matches.length}]`
        : "";
    return sorted.join("\n") + more;
  }
}

/** 按文件 mtime 倒序排序（读不到 stat 的当作最旧）。 */
export function sortByMtimeDesc(paths: string[]): string[] {
  return [...paths].sort((a, b) => mtimeOf(b) - mtimeOf(a));
}

function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 5: 注册到 AgentModule**

```typescript
import { GlobTool } from "./tools/builtins/glob.tool";
```
```typescript
    GlobTool,
```

- [ ] **Step 6: 运行确认通过 + 全量回归 + 围栏**

```bash
pnpm --filter @meshbot/agent test tests/unit/glob.tool.test.ts
pnpm --filter @meshbot/agent test
pnpm check
```
Expected: glob 测试 PASS；libs/agent 全量 PASS；7 道围栏全绿（无新增 finding）。

- [ ] **Step 7: Commit**

```bash
git add libs/agent/src/tools/builtins/glob.tool.ts libs/agent/tests/unit/glob.tool.test.ts libs/agent/src/agent.module.ts libs/agent/package.json
git commit -m "feat(agent): glob 工具（fast-glob + mtime 倒序）"
```

---

## Phase 2 — 流式实时预览（run.tool_call_args_delta，方案 A）

### Task 7: types-agent 新增 run.tool_call_args_delta 事件契约

**Files:**
- Modify: `libs/types-agent/src/session.ts`
- Test: `libs/types-agent/`（若已有 session schema 测试则追加；否则本 Task 只做契约，验证靠 typecheck）

**Interfaces:**
- Produces:
  - `RunToolCallArgsDeltaEventSchema` / `RunToolCallArgsDeltaEvent` = `{ sessionId, messageId, index, name?, delta }`
  - `SESSION_WS_EVENTS.runToolCallArgsDelta = "run.tool_call_args_delta"`

- [ ] **Step 1: 加 schema + type（在 RunToolCallProgressEventSchema 之后）**

在 `libs/types-agent/src/session.ts` 的 `RunToolCallEndEventSchema` 定义之前插入：

```typescript
/**
 * socket: run.tool_call_args_delta —— LLM 生成某个 tool_call 参数 JSON 的增量。
 * 纯瞬态（不落库），仅供前端流式「实时预览」write/edit 的内容。
 * `index` 标识同轮内第几个 tool_call；权威参数随后由 run.tool_call_start 给出。
 */
export const RunToolCallArgsDeltaEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  index: z.number().int(),
  name: z.string().optional(),
  delta: z.string(),
});
export type RunToolCallArgsDeltaEvent = z.infer<
  typeof RunToolCallArgsDeltaEventSchema
>;
```

- [ ] **Step 2: 加事件常量**

在 `SESSION_WS_EVENTS` 对象里，`runToolCallProgress` 行之后插入：

```typescript
  runToolCallArgsDelta: "run.tool_call_args_delta",
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/types-agent typecheck`
Expected: PASS（无类型错误）

- [ ] **Step 4: Commit**

```bash
git add libs/types-agent/src/session.ts
git commit -m "feat(types-agent): run.tool_call_args_delta 事件契约"
```

---

### Task 8: graph 层捕获 tool_call_chunks + runner emit

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts`（StreamChunk union + extractToolCallArgDeltas + 循环里 yield）
- Modify: `apps/server-agent/src/services/runner.service.ts`（consumeRunStream 处理新 kind）
- Test: `libs/agent/tests/unit/tool-call-arg-deltas.test.ts`

**Interfaces:**
- Consumes: `AIMessageChunk`（`@langchain/core/messages`）。
- Produces:
  - `extractToolCallArgDeltas(msg: AIMessageChunk): { index: number; name?: string; delta: string }[]`（导出，纯函数）
  - StreamChunk 新增 `{ kind: "tool_call_args"; messageId: string; index: number; name?: string; delta: string }`

- [ ] **Step 1: 写失败测试 tool-call-arg-deltas.test.ts**

```typescript
import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { extractToolCallArgDeltas } from "../../src/graph/graph.service.js";

describe("extractToolCallArgDeltas", () => {
  it("无 tool_call_chunks → 空数组", () => {
    const msg = new AIMessageChunk({ content: "hello" });
    expect(extractToolCallArgDeltas(msg)).toEqual([]);
  });

  it("抽取 index + name + args 增量", () => {
    const msg = new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        { name: "write_file", args: '{"file_p', index: 0, id: "x" },
      ],
    });
    expect(extractToolCallArgDeltas(msg)).toEqual([
      { index: 0, name: "write_file", delta: '{"file_p' },
    ]);
  });

  it("index 缺失时回退 0", () => {
    const msg = new AIMessageChunk({
      content: "",
      tool_call_chunks: [{ args: "ath", id: "x" }],
    });
    expect(extractToolCallArgDeltas(msg)).toEqual([
      { index: 0, name: undefined, delta: "ath" },
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meshbot/agent test tests/unit/tool-call-arg-deltas.test.ts`
Expected: FAIL（`extractToolCallArgDeltas` 未导出）

- [ ] **Step 3: 在 graph.service.ts 加纯函数 + StreamChunk kind**

在 `StreamChunk` union 里（`tool_calls` 之后）追加：

```typescript
  | {
      kind: "tool_call_args";
      messageId: string;
      index: number;
      name?: string;
      delta: string;
    }
```

在文件中 `StreamChunk` 定义之后、`@Injectable()` 之前加导出纯函数：

```typescript
/** 从一条 AIMessageChunk 抽取 tool_call 参数增量（流式预览用）。 */
export function extractToolCallArgDeltas(
  msg: AIMessageChunk,
): { index: number; name?: string; delta: string }[] {
  const chunks = (
    msg as {
      tool_call_chunks?: Array<{ index?: number; name?: string; args?: string }>;
    }
  ).tool_call_chunks;
  if (!chunks || chunks.length === 0) return [];
  const out: { index: number; name?: string; delta: string }[] = [];
  for (const c of chunks) {
    const delta = typeof c.args === "string" ? c.args : "";
    if (!delta && !c.name) continue;
    out.push({
      index: typeof c.index === "number" ? c.index : 0,
      name: c.name,
      delta,
    });
  }
  return out;
}
```

- [ ] **Step 4: 在 runGraphStream 循环里 yield**

在 `runGraphStream` 中，紧接 reasoning_done 检测块（`yield { kind: "reasoning_done", messageId: sid };` 所在 if 之后、`const reasoningDelta` 之前）插入：

```typescript
      for (const d of extractToolCallArgDeltas(msg)) {
        yield {
          kind: "tool_call_args",
          messageId: sid,
          index: d.index,
          name: d.name,
          delta: d.delta,
        };
      }
```

- [ ] **Step 5: 运行确认纯函数测试通过**

Run: `pnpm --filter @meshbot/agent test tests/unit/tool-call-arg-deltas.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 6: runner consumeRunStream 处理新 kind（关键：必须在 usage 兜底分支之前 continue）**

在 `apps/server-agent/src/services/runner.service.ts` 的 `consumeRunStream` 里，`if (event.kind === "tool_calls") { ... continue; }` 之后插入：

```typescript
      if (event.kind === "tool_call_args") {
        // 纯瞬态：转发给前端做实时预览，不落库。必须在此 continue，
        // 否则会落进末尾的 usage 兜底分支（event 字段不匹配 → 误记 LLM 调用）。
        this.emitter.emit(SESSION_WS_EVENTS.runToolCallArgsDelta, {
          sessionId,
          messageId: event.messageId,
          index: event.index,
          name: event.name,
          delta: event.delta,
        });
        continue;
      }
```

- [ ] **Step 7: typecheck（确认 runner 已穷尽 StreamChunk union）**

Run: `pnpm --filter @meshbot/server-agent typecheck && pnpm --filter @meshbot/agent typecheck`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add libs/agent/src/graph/graph.service.ts libs/agent/tests/unit/tool-call-arg-deltas.test.ts apps/server-agent/src/services/runner.service.ts
git commit -m "feat(agent): 捕获 tool_call_chunks 增量并经 runner emit 流式预览事件"
```

---

### Task 9: session.gateway 转发新事件

**Files:**
- Modify: `apps/server-agent/src/ws/session.gateway.ts`

**Interfaces:**
- Consumes: `SESSION_WS_EVENTS.runToolCallArgsDelta`、`RunToolCallArgsDeltaEvent`（Task 7）。

- [ ] **Step 1: 加 import**

确认 `session.gateway.ts` 顶部从 `@meshbot/types-agent` 的 import 列表里加入 `RunToolCallArgsDeltaEvent`（与已有 `RunToolCallProgressEvent` 等并列）。

- [ ] **Step 2: 加转发器（紧跟 onRunToolCallProgress 之后）**

```typescript
  /** run.tool_call_args_delta —— 原样转发到 session 房间（瞬态预览）。 */
  @OnEvent(SESSION_WS_EVENTS.runToolCallArgsDelta)
  onRunToolCallArgsDelta(payload: RunToolCallArgsDeltaEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runToolCallArgsDelta, payload);
  }
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/ws/session.gateway.ts
git commit -m "feat(server-agent): gateway 转发 run.tool_call_args_delta"
```

---

### Task 10: web-common 部分 JSON 解析工具（重点单测）

**Files:**
- Create: `packages/web-common/src/utils/partial-tool-args.ts`
- Test: `packages/web-common/src/utils/partial-tool-args.spec.ts`
- Modify: `packages/web-common/src/index.ts`（导出）、`packages/web-common/package.json`（加依赖）

**Interfaces:**
- Consumes: `best-effort-json-parser`。
- Produces:
  - `parsePartialToolArgs(text: string): Record<string, unknown>`（任何异常吞掉返回 `{}`）
  - `extractPartialString(text: string, key: string): string`

- [ ] **Step 1: 装依赖**

```bash
pnpm --filter @meshbot/web-common add best-effort-json-parser
```

- [ ] **Step 2: 写测试 partial-tool-args.spec.ts（never-throw + 单调揭示）**

```typescript
import { extractPartialString, parsePartialToolArgs } from "./partial-tool-args";

const FULL = JSON.stringify({ file_path: "a.txt", content: "line1\nline2\nline3" });

describe("parsePartialToolArgs", () => {
  it("完整 JSON 还原全部字段", () => {
    const v = parsePartialToolArgs(FULL);
    expect(v.file_path).toBe("a.txt");
    expect(v.content).toBe("line1\nline2\nline3");
  });

  it("空串 / 垃圾输入返回空对象，不抛", () => {
    expect(parsePartialToolArgs("")).toEqual({});
    expect(parsePartialToolArgs("   ")).toEqual({});
    expect(() => parsePartialToolArgs("{not json")).not.toThrow();
  });

  it("任意前缀截断都不抛异常", () => {
    for (let i = 0; i <= FULL.length; i++) {
      const prefix = FULL.slice(0, i);
      expect(() => extractPartialString(prefix, "content")).not.toThrow();
    }
  });

  it("揭示的 content 始终是最终值的前缀（不会出现错位内容）", () => {
    const final = "line1\nline2\nline3";
    for (let i = 0; i <= FULL.length; i++) {
      const revealed = extractPartialString(FULL.slice(0, i), "content");
      expect(final.startsWith(revealed)).toBe(true);
    }
  });

  it("取不到字段返回空串", () => {
    expect(extractPartialString("{}", "content")).toBe("");
    expect(extractPartialString('{"x":1}', "content")).toBe("");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @meshbot/web-common test -- src/utils/partial-tool-args.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 写 partial-tool-args.ts**

```typescript
import { parse as parseBestEffort } from "best-effort-json-parser";

/**
 * 尽力解析流式（可能未闭合）的 tool_call args JSON。
 * 任何异常都吞掉，返回空对象 —— 调用方据此「退回上一次成功值」。
 */
export function parsePartialToolArgs(text: string): Record<string, unknown> {
  if (!text || !text.trim()) return {};
  try {
    const v = parseBestEffort(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 从流式 args 里取某个字符串字段（content / new_string），取不到返回空串。 */
export function extractPartialString(text: string, key: string): string {
  const v = parsePartialToolArgs(text)[key];
  return typeof v === "string" ? v : "";
}
```

> 注：若安装的 `best-effort-json-parser` 导出名不是 `parse`，按其 README 调整 import；行为契约（never-throw + 揭示前缀）由本 spec 保证，导出名变更不影响测试断言。

- [ ] **Step 5: 从 index.ts 导出**

在 `packages/web-common/src/index.ts` 追加（与既有 re-export 同风格）：

```typescript
export { parsePartialToolArgs, extractPartialString } from "./utils/partial-tool-args";
```

- [ ] **Step 6: 运行确认通过**

Run: `pnpm --filter @meshbot/web-common test -- src/utils/partial-tool-args.spec.ts`
Expected: PASS（5 passed）

- [ ] **Step 7: Commit**

```bash
git add packages/web-common/src/utils/partial-tool-args.ts packages/web-common/src/utils/partial-tool-args.spec.ts packages/web-common/src/index.ts packages/web-common/package.json
git commit -m "feat(web-common): 流式 tool args 尽力部分解析工具"
```

---

### Task 11: web-agent 前端消费 + 实时预览渲染

**Files:**
- Modify: `apps/web-agent/src/components/session/message-list.tsx`（TimelineMessage 加字段 + 渲染预览）
- Create: `apps/web-agent/src/components/session/tool-call-args-preview.tsx`
- Modify: `apps/web-agent/src/hooks/use-session-stream.ts`（handler + 监听注册 + onToolStart 清理）

**Interfaces:**
- Consumes: `RunToolCallArgsDeltaEvent`、`SESSION_WS_EVENTS.runToolCallArgsDelta`、`parsePartialToolArgs` / `extractPartialString`（Task 10）。
- Produces: `TimelineMessage.streamingToolArgs?: { index: number; name?: string; argsText: string }[]`。

- [ ] **Step 1: TimelineMessage 加字段**

在 `apps/web-agent/src/components/session/message-list.tsx` 的 `interface TimelineMessage`（约 28-63 行）里，`toolCalls?: ToolCallView[];` 旁边加：

```typescript
  /** LLM 正在生成、尚未收尾的 tool_call 参数增量（流式预览用，按 index）。 */
  streamingToolArgs?: { index: number; name?: string; argsText: string }[];
```

- [ ] **Step 2: 写预览组件 tool-call-args-preview.tsx**

```tsx
"use client";

import { extractPartialString, parsePartialToolArgs } from "@meshbot/web-common";

/**
 * LLM 正在「打字」生成 write_file/edit_file 内容时的实时预览块。
 * 对未闭合的 args JSON 尽力部分解析，抽出 file_path + content/new_string 逐字展示。
 */
export function ToolCallArgsPreview({
  name,
  argsText,
}: {
  name?: string;
  argsText: string;
}) {
  const parsed = parsePartialToolArgs(argsText);
  const filePath = typeof parsed.file_path === "string" ? parsed.file_path : "";
  const body =
    extractPartialString(argsText, "content") ||
    extractPartialString(argsText, "new_string");
  const label = name ?? "tool";
  return (
    <div className="flex w-full flex-col rounded-[8px] border border-border overflow-hidden">
      <div className="flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
        <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary/70" />
        <span className="font-mono text-foreground">{label}</span>
        {filePath && (
          <span className="min-w-0 truncate font-mono text-muted-foreground/70">
            ({filePath})
          </span>
        )}
      </div>
      {body && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground">
          {body}
          <span className="animate-pulse">▋</span>
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 在 message-list 渲染预览**

在 `message-list.tsx` 渲染 `toolCalls` 的相邻位置（`m.toolCalls?.map(... ToolCallBlock ...)` 之后），加预览渲染。先在文件顶部 import：

```typescript
import { ToolCallArgsPreview } from "./tool-call-args-preview";
```

在 toolCalls 渲染块后追加：

```tsx
{m.streamingToolArgs?.map((s) => (
  <ToolCallArgsPreview key={`pre-${s.index}`} name={s.name} argsText={s.argsText} />
))}
```

- [ ] **Step 4: hook 加 handler + onToolStart 清理 + 注册监听**

在 `apps/web-agent/src/hooks/use-session-stream.ts`：

(a) import 类型（与既有 `RunToolCallStartEvent` 等并列）：

```typescript
import type { RunToolCallArgsDeltaEvent } from "@meshbot/types-agent";
```

(b) 在 `onToolStart` 返回对象里追加清理（authoritative toolCalls 接管，预览撤掉）。把 `streaming: false,` 旁边加：

```typescript
            streamingToolArgs: undefined,
```

(c) 在 `onToolStart` 定义之前（或 `onToolEnd` 之后）加 handler，upsert 语义保证纯 tool_call 轮也能显示预览：

```typescript
    const onToolArgsDelta = (e: RunToolCallArgsDeltaEvent) => {
      if (e.sessionId !== sessionId) return;
      apply((prev) => {
        const append = (m: TimelineMessage): TimelineMessage => {
          const list = m.streamingToolArgs ? [...m.streamingToolArgs] : [];
          const i = list.findIndex((s) => s.index === e.index);
          if (i === -1) {
            list.push({ index: e.index, name: e.name, argsText: e.delta });
          } else {
            list[i] = {
              ...list[i],
              name: e.name ?? list[i].name,
              argsText: list[i].argsText + e.delta,
            };
          }
          return { ...m, streamingToolArgs: list };
        };
        const idx = prev.findIndex((m) => m.id === e.messageId);
        if (idx === -1) {
          return [
            ...prev,
            append({ id: e.messageId, role: "assistant", content: "", streaming: true }),
          ];
        }
        const copy = [...prev];
        copy[idx] = append(copy[idx]);
        return copy;
      });
    };
```

(d) 注册监听（紧跟 `socket.on(SESSION_WS_EVENTS.runToolCallStart, onToolStart);` 之前）：

```typescript
    socket.on(SESSION_WS_EVENTS.runToolCallArgsDelta, onToolArgsDelta);
```

(e) 在 cleanup 的 `socket.off(...)` 区（与其它 `runToolCall*` 解绑并列）加：

```typescript
      socket.off(SESSION_WS_EVENTS.runToolCallArgsDelta, onToolArgsDelta);
```

> 注：若该 hook 的 cleanup 用 `socket.removeAllListeners` 或别的解绑写法，按文件既有风格对齐即可。`TimelineMessage` 若未被 hook 直接 import，用其等价的 message 联合类型（与 `upsertChunk` 创建消息处相同的类型）。

- [ ] **Step 5: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: PASS。

- [ ] **Step 6: 手动验证（真实跑一次）**

```bash
pnpm dev:server-agent   # 终端 1
pnpm dev:web-agent      # 终端 2
```
在 web-agent 里让助手写一个文件（如「在 workspace 写一个 hello.md，内容是一段较长的介绍」）。预期：
- tool 执行前，能看到 `write_file (hello.md)` 预览块里内容逐字「打」出来（带闪烁光标）。
- tool 开始执行（run.tool_call_start）后，预览块消失，换成正式的 ToolCallBlock（✓ 状态 + 结果）。
- 再让助手 `read_file` 后 `edit_file` 改一处，确认编辑成功且返回行号片段；直接 edit 未读过的文件应被拒绝。

- [ ] **Step 7: 全量围栏 + Commit**

```bash
pnpm check
git add apps/web-agent/src/components/session/message-list.tsx apps/web-agent/src/components/session/tool-call-args-preview.tsx apps/web-agent/src/hooks/use-session-stream.ts
git commit -m "feat(web-agent): tool_call 参数流式实时预览（write/edit 打字效果）"
```

---

## Self-Review（计划自检）

**Spec 覆盖：**
- read_file / write_file / edit_file / grep / glob → Task 2/3/4/5/6 ✓
- FileStateService + 两条铁律（read-before-write、原子写）→ Task 1（service）+ Task 3（atomicWrite + assertFresh）+ Task 4（edit assertFresh）✓
- 全文件系统访问 + 相对路径对 workspace 解析 → `resolveFilePath`（Task 1）✓
- 编辑靠字符串匹配、返回行号片段、不走 bash → Task 4 `snippetAround` ✓
- 流式预览：graph 捕获 tool_call_chunks → Task 8；新事件契约 → Task 7；gateway 转发 → Task 9；前端部分解析 + 渲染 → Task 10/11 ✓
- 部分 JSON 解析「重点单测」（never-throw + 揭示前缀）→ Task 10 ✓
- 双截断 → 复用现有 `tools.node` 的 `capForLlm`（无需改动；新工具结果自动走该路径）✓

**占位符扫描：** 无 TBD/TODO；每步含可执行命令与完整代码。两处「注」是实现期的对齐提示（导出名、cleanup 写法），非占位符。

**类型一致性：** `resolveFilePath` / `FileStat` / `FileStateService.assertFresh` / `atomicWrite` / `buildRgArgs` / `sortByMtimeDesc` / `extractToolCallArgDeltas` / `RunToolCallArgsDeltaEvent` / `parsePartialToolArgs` / `extractPartialString` / `TimelineMessage.streamingToolArgs` 在定义 Task 与消费 Task 间签名一致。

**已知实现期校验点（非阻塞，TDD 会即时暴露）：**
- `best-effort-json-parser` 导出名（Task 10 注）。
- `use-session-stream.ts` 的 socket 解绑写法与 `TimelineMessage` 可见性（Task 11 注）。
- `message-list.tsx` 中 toolCalls 的确切渲染位置（按文件实读对齐）。
