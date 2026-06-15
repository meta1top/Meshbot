import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service.js";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service.js";

function makeService(): MeshbotConfigService {
  return new MeshbotConfigService(new AccountContextService());
}

describe("MeshbotConfigService", () => {
  it("returns meshbot directory path", () => {
    const dir = makeService().getMeshbotDir();
    expect(typeof dir).toBe("string");
    expect(dir).toContain(".meshbot");
  });

  it("returns database path（共享，不依赖账号上下文）", () => {
    const dbPath = makeService().getDatabasePath();
    expect(dbPath).toContain(".meshbot");
    expect(dbPath).toContain("agent.db");
  });

  it("prompt 目录需账号上下文，无上下文抛错", () => {
    expect(() => makeService().getPromptDir()).toThrow();
  });

  it("prompt 目录落在 accounts/<account> 下", () => {
    const ctx = new AccountContextService();
    const service = new MeshbotConfigService(ctx);
    ctx.run("acc-1", () => {
      const dir = service.getPromptDir();
      expect(dir).toContain(".meshbot");
      expect(dir).toContain(path.join("accounts", "acc-1", "prompt"));
    });
  });
});

describe("MeshbotConfigService MESHBOT_HOME 覆盖", () => {
  const original = process.env.MESHBOT_HOME;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MESHBOT_HOME;
    } else {
      process.env.MESHBOT_HOME = original;
    }
  });

  it("设了 MESHBOT_HOME 后，共享路径落在该目录下；账号化路径落在 accounts/<account>", () => {
    const root = "/tmp/meshbot-per-account-test-home";
    process.env.MESHBOT_HOME = root;

    const ctx = new AccountContextService();
    const service = new MeshbotConfigService(ctx);

    expect(service.getMeshbotDir()).toBe(root);
    expect(service.getDatabasePath()).toBe(path.join(root, "agent.db"));

    ctx.run("acc-1", () => {
      const accRoot = path.join(root, "accounts", "acc-1");
      expect(service.getMcpConfigPath()).toBe(path.join(accRoot, "mcp.json"));
      expect(service.getSkillsDir()).toBe(path.join(accRoot, "skills"));
      expect(service.getPromptDir()).toBe(path.join(accRoot, "prompt"));
    });
  });
});
