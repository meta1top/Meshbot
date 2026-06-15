import { EventEmitter2 } from "@nestjs/event-emitter";
import { AccountContextService } from "../../account/account-context.service";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { BashTool } from "./bash.tool";
import type { ToolContext } from "../tool.types";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: "s1",
    messageId: "m1",
    toolCallId: "tc1",
    emitter: new EventEmitter2(),
    signal: ctrl.signal,
    ...overrides,
  };
}

describe("BashTool", () => {
  const tmpDir = "/tmp";
  // MESHBOT_WORKSPACE 覆盖 getWorkspaceDir，故此处无需账号上下文。
  process.env.MESHBOT_WORKSPACE = tmpDir;
  const config = new MeshbotConfigService(new AccountContextService());
  const tool = new BashTool(config);

  it("echo hello 返成功 + 含 exit 0 和 stdout", async () => {
    const out = await tool.execute({ command: "echo hello" }, makeCtx());
    expect(out).toMatch(/^\[exit 0\]/);
    expect(out).toContain("hello");
  }, 10_000);

  it("非零退出码 返 [exit N]", async () => {
    const out = await tool.execute({ command: "exit 7" }, makeCtx());
    expect(out).toMatch(/^\[exit 7\]/);
  }, 10_000);

  it("emit run.tool_call_progress for stdout", async () => {
    const ctx = makeCtx();
    const events: { delta: string }[] = [];
    ctx.emitter.on("run.tool_call_progress", (e: { delta: string }) =>
      events.push(e),
    );
    await tool.execute({ command: "echo abc; echo def" }, ctx);
    const combined = events.map((e) => e.delta).join("");
    expect(combined).toContain("abc");
    expect(combined).toContain("def");
  }, 10_000);

  it("abort signal 中断命令", async () => {
    const ctrl = new AbortController();
    const ctx = makeCtx({ signal: ctrl.signal });
    const p = tool.execute({ command: "sleep 5" }, ctx);
    setTimeout(() => ctrl.abort(), 100);
    const out = await p;
    expect(out).toMatch(/^\[exit (signal:|null)/);
  }, 10_000);
});
