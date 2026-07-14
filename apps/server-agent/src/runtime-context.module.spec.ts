import { QUICK_ASSISTANT_EVENTS } from "@meshbot/types-agent";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { Agent } from "./entities/agent.entity";
import { createAgentRenamePort } from "./runtime-context.module";
import type { AgentService } from "./services/agent.service";

const DEFAULT_AGENT = { id: "agent-default", name: "M" } as Agent;

function make(defaultAgent: Agent = DEFAULT_AGENT) {
  const agents = {
    update: jest
      .fn()
      .mockImplementation((id: string, input: { name: string }) =>
        Promise.resolve({ id, name: input.name } as Agent),
      ),
    ensureDefault: jest.fn().mockResolvedValue(defaultAgent),
  } as unknown as jest.Mocked<Pick<AgentService, "update" | "ensureDefault">>;
  const emit = jest.fn();
  const emitter = { emit } as unknown as EventEmitter2;
  const port = createAgentRenamePort(
    agents as unknown as AgentService,
    emitter,
  );
  return { port, agents, emit };
}

describe("createAgentRenamePort", () => {
  it("改名默认 Agent（agentId === ensureDefault().id）→ 发 quick_assistant.renamed 事件", async () => {
    const { port, agents, emit } = make();

    await port.rename("agent-default", "小助手");

    expect(agents.update).toHaveBeenCalledWith("agent-default", {
      name: "小助手",
    });
    expect(emit).toHaveBeenCalledWith(QUICK_ASSISTANT_EVENTS.renamed, {
      name: "小助手",
    });
  });

  it("改名非默认 Agent（agentId !== ensureDefault().id）→ 不发事件", async () => {
    const { port, agents, emit } = make(DEFAULT_AGENT);

    await port.rename("agent-other", "运维值班");

    expect(agents.update).toHaveBeenCalledWith("agent-other", {
      name: "运维值班",
    });
    expect(emit).not.toHaveBeenCalled();
  });
});
