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
    const out = await tool.execute(
      { file_path: f, offset: 2, limit: 2 },
      makeCtx(),
    );
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
    const out = await tool.execute(
      { file_path: path.join(dir, "nope.txt") },
      makeCtx(),
    );
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
