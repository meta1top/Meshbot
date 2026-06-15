import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service.js";

describe("MeshbotConfigService", () => {
  it("returns meshbot directory path", () => {
    const service = new MeshbotConfigService();
    const dir = service.getMeshbotDir();
    expect(typeof dir).toBe("string");
    expect(dir).toContain(".meshbot");
  });

  it("returns prompt directory path", () => {
    const service = new MeshbotConfigService();
    const dir = service.getPromptDir();
    expect(dir).toContain(".meshbot");
    expect(dir).toContain("prompt");
  });

  it("returns database path", () => {
    const service = new MeshbotConfigService();
    const dbPath = service.getDatabasePath();
    expect(dbPath).toContain(".meshbot");
    expect(dbPath).toContain("agent.db");
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

  it("设了 MESHBOT_HOME 后，所有路径都落在该目录下（整棵树跟随）", () => {
    const root = "/tmp/meshbot-per-account-test-home";
    process.env.MESHBOT_HOME = root;

    const service = new MeshbotConfigService();

    expect(service.getMeshbotDir()).toBe(root);
    expect(service.getDatabasePath()).toBe(path.join(root, "agent.db"));
    expect(service.getMcpConfigPath()).toBe(path.join(root, "mcp.json"));
    expect(service.getSkillsDir()).toBe(path.join(root, "skills"));
    expect(service.getPromptDir()).toBe(path.join(root, "prompt"));
  });
});
