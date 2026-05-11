import { describe, expect, it } from "vitest";
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
