import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AgentModule } from "../../src/agent.module";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { GraphRunner } from "../../src/graph/graph-runner.service";
import { PromptService } from "../../src/prompt/prompt.service";
import { ToolRegistry } from "../../src/tools/tool-registry";

describe("AgentModule", () => {
  it("compiles and provides GraphRunner", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AgentModule],
    }).compile();

    const graphRunner = moduleRef.get(GraphRunner);
    expect(graphRunner).toBeDefined();
  });

  it("provides PromptService", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AgentModule],
    }).compile();

    const promptService = moduleRef.get(PromptService);
    expect(promptService).toBeDefined();
  });

  it("provides MeshbotConfigService", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AgentModule],
    }).compile();

    const configService = moduleRef.get(MeshbotConfigService);
    expect(configService).toBeDefined();
  });

  it("provides ToolRegistry", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AgentModule],
    }).compile();

    const toolRegistry = moduleRef.get(ToolRegistry);
    expect(toolRegistry).toBeDefined();
  });
});
