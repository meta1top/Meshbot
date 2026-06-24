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
    const out = await tool.execute(
      { file_path: f, content: "hello\nworld" },
      makeCtx(),
    );
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
