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

  it("删除（new_string 为空）→ 片段定位编辑处而非文件末尾", async () => {
    const { tool, f } = setup("aaa\nDELME\nbbb\nccc\nddd\neee\nfff\nggg");
    const out = await tool.execute(
      { file_path: f, old_string: "DELME\n", new_string: "" },
      makeCtx(),
    );
    expect(readFileSync(f, "utf8")).toBe("aaa\nbbb\nccc\nddd\neee\nfff\nggg");
    expect(out).toContain("aaa");
    expect(out).not.toContain("ggg");
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
