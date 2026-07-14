import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { AgentContextService } from "@meshbot/lib-agent";
import type { MeshbotConfigService } from "@meshbot/lib-agent";
import type { Agent } from "../entities/agent.entity";
import type { AgentService } from "../services/agent.service";
import { ArtifactController } from "./artifact.controller";

const DEFAULT_AGENT_ID = "agent-default";
const EXPLICIT_AGENT_ID = "agent-explicit";

function make(ws: string) {
  const config = {
    getWorkspaceDir: () => ws,
  } as unknown as MeshbotConfigService;
  const agentCtx = new AgentContextService();
  const agents = {
    ensureDefault: jest
      .fn()
      .mockResolvedValue({ id: DEFAULT_AGENT_ID } as Agent),
    findOrThrow: jest
      .fn()
      .mockResolvedValue({ id: EXPLICIT_AGENT_ID } as Agent),
  } as unknown as AgentService;
  return {
    controller: new ArtifactController(config, agentCtx, agents),
    agents,
  };
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
  it("workspace 内文件 → StreamableFile + Content-Type", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "a.html"), "<h1>x</h1>");
    const res = fakeRes();
    const { controller } = make(ws);
    const out = await controller.raw("a.html", undefined, undefined, res);
    expect(out).toBeDefined();
    expect(
      (res as unknown as { headers: Record<string, string> }).headers[
        "Content-Type"
      ],
    ).toBe("text/html");
  });
  it("未传 agentId → 兜底走 ensureDefault", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "a.html"), "<h1>x</h1>");
    const { controller, agents } = make(ws);
    await controller.raw("a.html", undefined, undefined, fakeRes());
    expect(agents.ensureDefault).toHaveBeenCalled();
    expect(agents.findOrThrow).not.toHaveBeenCalled();
  });
  it("显式传 agentId → 走 findOrThrow 校验", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "a.html"), "<h1>x</h1>");
    const { controller, agents } = make(ws);
    await controller.raw("a.html", undefined, EXPLICIT_AGENT_ID, fakeRes());
    expect(agents.findOrThrow).toHaveBeenCalledWith(EXPLICIT_AGENT_ID);
  });
  it("download=1 → Content-Disposition attachment", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(ws, "a.md"), "# x");
    const res = fakeRes();
    const { controller } = make(ws);
    await controller.raw("a.md", "1", undefined, res);
    expect(
      (res as unknown as { headers: Record<string, string> }).headers[
        "Content-Disposition"
      ],
    ).toContain("attachment");
  });
  it("路径遍历 ../ → ForbiddenException", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    const { controller } = make(ws);
    await expect(
      controller.raw("../../etc/passwd", undefined, undefined, fakeRes()),
    ).rejects.toThrow(ForbiddenException);
  });
  it("绝对路径 /etc/passwd → ForbiddenException", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    const { controller } = make(ws);
    await expect(
      controller.raw("/etc/passwd", undefined, undefined, fakeRes()),
    ).rejects.toThrow(ForbiddenException);
  });
  it("不存在 → NotFoundException", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    const { controller } = make(ws);
    await expect(
      controller.raw("nope.md", undefined, undefined, fakeRes()),
    ).rejects.toThrow(NotFoundException);
  });
  it("空路径指向 workspace 目录 → NotFoundException", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
    const { controller } = make(ws);
    await expect(
      controller.raw("", undefined, undefined, fakeRes()),
    ).rejects.toThrow(NotFoundException);
  });
});
