import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { MeshbotConfigService } from "@meshbot/agent";
import { ArtifactController } from "./artifact.controller";

function make(ws: string) {
  const config = {
    getWorkspaceDir: () => ws,
  } as unknown as MeshbotConfigService;
  return new ArtifactController(config);
}
function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    headers,
  } as never;
}

describe("ArtifactController.raw", () => {
  it("workspace 内文件 → StreamableFile + Content-Type", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "a.html"), "<h1>x</h1>");
    const res = fakeRes();
    const out = make(ws).raw("a.html", undefined, res);
    expect(out).toBeDefined();
    expect(
      (res as unknown as { headers: Record<string, string> }).headers[
        "Content-Type"
      ],
    ).toBe("text/html");
  });
  it("download=1 → Content-Disposition attachment", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "a.md"), "# x");
    const res = fakeRes();
    make(ws).raw("a.md", "1", res);
    expect(
      (res as unknown as { headers: Record<string, string> }).headers[
        "Content-Disposition"
      ],
    ).toContain("attachment");
  });
  it("路径遍历 ../ → ForbiddenException", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    expect(() =>
      make(ws).raw("../../etc/passwd", undefined, fakeRes()),
    ).toThrow(ForbiddenException);
  });
  it("绝对路径 /etc/passwd → ForbiddenException", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    expect(() => make(ws).raw("/etc/passwd", undefined, fakeRes())).toThrow(
      ForbiddenException,
    );
  });
  it("不存在 → NotFoundException", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    expect(() => make(ws).raw("nope.md", undefined, fakeRes())).toThrow(
      NotFoundException,
    );
  });
  it("空路径指向 workspace 目录 → NotFoundException", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    expect(() => make(ws).raw("", undefined, fakeRes())).toThrow(
      NotFoundException,
    );
  });
});
