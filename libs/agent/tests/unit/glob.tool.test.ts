import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GlobTool,
  sortByMtimeDesc,
} from "../../src/tools/builtins/glob.tool.js";
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
