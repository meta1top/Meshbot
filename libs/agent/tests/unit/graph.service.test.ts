import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { GraphService } from "../../src/graph/graph.service";
import { PromptService } from "../../src/prompt/prompt.service";

describe("GraphService", () => {
  let testDir: string;
  let graphService: GraphService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-graph-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const configService = new MeshbotConfigService();
    (configService as any).meshbotDir = testDir;
    const promptService = new PromptService(testDir);
    graphService = new GraphService(configService, promptService);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("starts a session and returns thread id", async () => {
    const threadId = await graphService.startSession({ model: "gpt-4" });
    expect(typeof threadId).toBe("string");
    expect(threadId.length).toBeGreaterThan(0);
  });

  it("sends message and returns response", async () => {
    const threadId = await graphService.startSession({ model: "gpt-4" });
    const response = await graphService.sendMessage(threadId, "Hello");
    expect(response.threadId).toBe(threadId);
    expect(typeof response.content).toBe("string");
  });

  it("returns history after messages", async () => {
    const threadId = await graphService.startSession({ model: "gpt-4" });
    await graphService.sendMessage(threadId, "Hello");
    const history = await graphService.getHistory(threadId);
    expect(Array.isArray(history)).toBe(true);
  });
});
