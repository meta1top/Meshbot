import { AgentContextService } from "@meshbot/lib-agent";
import type { InstalledSkill } from "@meshbot/types-agent";
import type { Agent } from "../entities/agent.entity";
import type { AgentService } from "../services/agent.service";
import type { SkillInstallService } from "../skills/skill-install.service";
import { SkillController } from "./skill.controller";

const DEFAULT_AGENT_ID = "agent-default";
const EXPLICIT_AGENT_ID = "agent-explicit";

function makeInstallService(): jest.Mocked<
  Pick<
    SkillInstallService,
    "market" | "install" | "uninstall" | "listInstalled" | "publish"
  >
> {
  return {
    market: jest.fn().mockResolvedValue([]),
    install: jest.fn().mockResolvedValue({} as InstalledSkill),
    uninstall: jest.fn().mockResolvedValue(undefined),
    listInstalled: jest.fn().mockResolvedValue([]),
    publish: jest.fn().mockResolvedValue(undefined),
  };
}

function makeAgents(): jest.Mocked<
  Pick<AgentService, "ensureDefault" | "findOrThrow" | "resolveOrDefault">
> {
  const ensureDefault = jest
    .fn()
    .mockResolvedValue({ id: DEFAULT_AGENT_ID } as Agent);
  const findOrThrow = jest
    .fn()
    .mockResolvedValue({ id: EXPLICIT_AGENT_ID } as Agent);
  return {
    ensureDefault,
    findOrThrow,
    // 复刻真实 AgentService.resolveOrDefault 的分支逻辑，让本文件既有的
    // ensureDefault/findOrThrow 断言继续生效。
    resolveOrDefault: jest.fn((agentId?: string | null) =>
      agentId ? findOrThrow(agentId) : ensureDefault(),
    ),
  };
}

function make() {
  const installService = makeInstallService();
  const agentCtx = new AgentContextService();
  const agents = makeAgents();
  const controller = new SkillController(
    installService as unknown as SkillInstallService,
    agentCtx,
    agents as unknown as AgentService,
  );
  return { controller, installService, agentCtx, agents };
}

describe("SkillController", () => {
  it("market：不解析 agentId，直接透传", async () => {
    const { controller, installService, agents } = make();
    await controller.market("github", "q");
    expect(installService.market).toHaveBeenCalledWith("github", "q");
    expect(agents.ensureDefault).not.toHaveBeenCalled();
    expect(agents.findOrThrow).not.toHaveBeenCalled();
  });

  it("listInstalled：未传 agentId → ensureDefault 兜底，在该 Agent 上下文内调用", async () => {
    const { controller, installService, agentCtx, agents } = make();
    let capturedAgentId: string | null = null;
    installService.listInstalled.mockImplementation(async () => {
      capturedAgentId = agentCtx.get();
      return [];
    });

    await controller.listInstalled(undefined);

    expect(agents.ensureDefault).toHaveBeenCalled();
    expect(capturedAgentId).toBe(DEFAULT_AGENT_ID);
  });

  it("listInstalled：显式传 agentId → findOrThrow 校验并在该 Agent 上下文内调用", async () => {
    const { controller, installService, agentCtx, agents } = make();
    let capturedAgentId: string | null = null;
    installService.listInstalled.mockImplementation(async () => {
      capturedAgentId = agentCtx.get();
      return [];
    });

    await controller.listInstalled(EXPLICIT_AGENT_ID);

    expect(agents.findOrThrow).toHaveBeenCalledWith(EXPLICIT_AGENT_ID);
    expect(capturedAgentId).toBe(EXPLICIT_AGENT_ID);
  });

  it("install：body.agentId 未传 → ensureDefault 兜底", async () => {
    const { controller, installService, agentCtx, agents } = make();
    let capturedAgentId: string | null = null;
    installService.install.mockImplementation(async () => {
      capturedAgentId = agentCtx.get();
      return {} as InstalledSkill;
    });

    await controller.install({
      source: "github",
      ref: "owner/repo",
    } as never);

    expect(agents.ensureDefault).toHaveBeenCalled();
    expect(capturedAgentId).toBe(DEFAULT_AGENT_ID);
  });

  it("uninstall：agentId 走 query 参数解析", async () => {
    const { controller, installService, agentCtx, agents } = make();
    let capturedAgentId: string | null = null;
    installService.uninstall.mockImplementation(async () => {
      capturedAgentId = agentCtx.get();
    });

    await controller.uninstall("demo", EXPLICIT_AGENT_ID);

    expect(agents.findOrThrow).toHaveBeenCalledWith(EXPLICIT_AGENT_ID);
    expect(installService.uninstall).toHaveBeenCalledWith("demo");
    expect(capturedAgentId).toBe(EXPLICIT_AGENT_ID);
  });

  it("publish：body.agentId 未传 → ensureDefault 兜底", async () => {
    const { controller, installService, agentCtx, agents } = make();
    let capturedAgentId: string | null = null;
    installService.publish.mockImplementation(async () => {
      capturedAgentId = agentCtx.get();
    });

    await controller.publish({
      name: "demo",
      slug: "demo",
      displayName: "Demo",
      version: "1.0.0",
    } as never);

    expect(agents.ensureDefault).toHaveBeenCalled();
    expect(capturedAgentId).toBe(DEFAULT_AGENT_ID);
  });
});
