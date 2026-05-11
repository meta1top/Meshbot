import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AgentModule } from "../../src/agent.module";
import { GraphService } from "../../src/graph/graph.service";

describe("AgentModule", () => {
  it("compiles and provides GraphService", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AgentModule],
    }).compile();

    const graphService = moduleRef.get(GraphService);
    expect(graphService).toBeDefined();
  });
});
