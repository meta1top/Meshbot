import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AgentModule } from "../../src/agent.module";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { GraphService } from "../../src/graph/graph.service";
import { PromptService } from "../../src/prompt/prompt.service";
import { ToolRegistry } from "../../src/tools/tool-registry";

describe("AgentModule", () => {
  it("compiles and provides GraphService", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AgentModule],
    }).compile();

    const graphService = moduleRef.get(GraphService);
    expect(graphService).toBeDefined();
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
