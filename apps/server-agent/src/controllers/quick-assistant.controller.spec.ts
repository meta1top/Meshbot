import { QUICK_ASSISTANT_EVENTS } from "@meshbot/types-agent";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { Agent } from "../entities/agent.entity";
import type { AgentService } from "../services/agent.service";
import { QuickAssistantController } from "./quick-assistant.controller";

const DEFAULT_AGENT = { id: "agent-default", name: "M" } as Agent;

function make() {
  const agents = {
    ensureDefault: jest.fn().mockResolvedValue(DEFAULT_AGENT),
    update: jest.fn().mockResolvedValue({ ...DEFAULT_AGENT, name: "小M" }),
  } as unknown as jest.Mocked<Pick<AgentService, "ensureDefault" | "update">>;
  const emit = jest.fn();
  const emitter = { emit } as unknown as EventEmitter2;
  const controller = new QuickAssistantController(
    agents as unknown as AgentService,
    emitter,
  );
  return { controller, agents, emit };
}

describe("QuickAssistantController", () => {
  it("getName 返回默认 Agent 的 name", async () => {
    const { controller, agents } = make();

    const res = await controller.getName();

    expect(agents.ensureDefault).toHaveBeenCalled();
    expect(res).toEqual({ name: "M" });
  });

  it("rename 改默认 Agent 的 name 并发 ws renamed 事件", async () => {
    const { controller, agents, emit } = make();

    const res = await controller.rename({ name: "小M" });

    expect(agents.update).toHaveBeenCalledWith("agent-default", {
      name: "小M",
    });
    expect(emit).toHaveBeenCalledWith(QUICK_ASSISTANT_EVENTS.renamed, {
      name: "小M",
    });
    expect(res).toEqual({ name: "小M" });
  });
});
