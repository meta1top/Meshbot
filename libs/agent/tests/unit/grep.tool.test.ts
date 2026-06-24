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
      buildRgArgs({
        pattern: "foo",
        output_mode: "content",
        case_insensitive: true,
        context: 2,
      }),
    ).toEqual(["-n", "-i", "-C", "2", "--", "foo", "."]);
  });
  it("count 模式 → -c", () => {
    expect(buildRgArgs({ pattern: "x", output_mode: "count" })).toEqual([
      "-c",
      "--",
      "x",
      ".",
    ]);
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
