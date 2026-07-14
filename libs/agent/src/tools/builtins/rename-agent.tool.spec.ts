import { vi } from "vitest";
import { AgentContextService } from "../../account/agent-context.service";
import type { AgentRenamePort } from "../agent-rename.port";
import { RenameAgentTool } from "./rename-agent.tool";

describe("rename_agent tool", () => {
  it("rename_agent 改当前 Agent 的名字", async () => {
    const agentCtx = new AgentContextService();
    const port: AgentRenamePort = {
      rename: vi.fn().mockResolvedValue(undefined),
    };
    const tool = new RenameAgentTool(agentCtx, port);

    await agentCtx.run("agent-3", () => tool.execute({ name: "运维值班" }));

    expect(port.rename).toHaveBeenCalledWith("agent-3", "运维值班");
  });

  it("无 Agent 上下文时抛错", async () => {
    const agentCtx = new AgentContextService();
    const port: AgentRenamePort = {
      rename: vi.fn().mockResolvedValue(undefined),
    };
    const tool = new RenameAgentTool(agentCtx, port);

    await expect(tool.execute({ name: "X" })).rejects.toThrow(
      /无活跃 Agent 上下文/,
    );
  });
});
