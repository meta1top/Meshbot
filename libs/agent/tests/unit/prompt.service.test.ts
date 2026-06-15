import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { PromptService } from "../../src/prompt/prompt.service";

const ACCOUNT = "u-test";

function makeServices(meshbotDir: string): {
  ctx: AccountContextService;
  svc: PromptService;
} {
  const ctx = new AccountContextService();
  const cfg = new MeshbotConfigService(ctx);
  (cfg as unknown as { meshbotDir: string }).meshbotDir = meshbotDir;
  return { ctx, svc: new PromptService(cfg, ctx) };
}

function writePromptFile(
  meshbotDir: string,
  name: string,
  content: string,
): string {
  const dir = path.join(meshbotDir, "accounts", ACCOUNT, "prompt");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.md`);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("PromptService", () => {
  let testDir: string;
  let ctx: AccountContextService;
  let service: PromptService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-prompt-test-"));
    const s = makeServices(testDir);
    ctx = s.ctx;
    service = s.svc;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads prompts from .md files", () => {
    writePromptFile(testDir, "system", "You are a helpful assistant.");
    const result = ctx.run(ACCOUNT, () => service.getPrompt("system"));
    expect(result).toBe("You are a helpful assistant.");
  });

  it("returns undefined for missing prompt", () => {
    const result = ctx.run(ACCOUNT, () => service.getPrompt("missing"));
    expect(result).toBeUndefined();
  });

  it("reloads when file changes", () => {
    const filePath = writePromptFile(testDir, "system", "Original.");
    expect(ctx.run(ACCOUNT, () => service.getPrompt("system"))).toBe(
      "Original.",
    );

    writeFileSync(filePath, "Updated.", "utf8");
    const future = new Date(Date.now() + 2000);
    utimesSync(filePath, future, future);

    ctx.run(ACCOUNT, () => service.reloadIfChanged());
    expect(ctx.run(ACCOUNT, () => service.getPrompt("system"))).toBe(
      "Updated.",
    );
  });
});
