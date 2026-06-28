import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { PresentFileTool } from "../../src/tools/builtins/present-file.tool";

function toolWith(ws: string) {
  const config = {
    getWorkspaceDir: () => ws,
  } as unknown as MeshbotConfigService;
  return new PresentFileTool(config);
}
const ctx = { sessionId: "s1", toolCallId: "t1" } as never;

describe("present_file tool", () => {
  it("呈现 workspace 内存在的文件 → 返回相对 path + name + size", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "report.html"), "<h1>hi</h1>");
    const out = JSON.parse(
      await toolWith(ws).execute({ path: "report.html" }, ctx),
    );
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
