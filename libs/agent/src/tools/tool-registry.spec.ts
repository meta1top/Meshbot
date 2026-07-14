import { tool as createLcTool } from "@langchain/core/tools";
import { DiscoveryService } from "@nestjs/core";
import { z } from "zod";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import { Tool } from "./tool.decorator";
import { ToolRegistry } from "./tool-registry";
import type { MeshbotTool, ToolContext } from "./tool.types";

@Tool()
class FakeAlphaTool implements MeshbotTool<{ x: number }, string> {
  readonly name = "alpha";
  readonly description = "Alpha tool";
  readonly schema = z.object({ x: z.number() });
  async execute(args: { x: number }, _ctx: ToolContext): Promise<string> {
    return `alpha:${args.x}`;
  }
}

@Tool()
class FakeBetaTool implements MeshbotTool<{ y: string }, string> {
  readonly name = "beta";
  readonly description = "Beta tool";
  readonly schema = z.object({ y: z.string() });
  async execute(args: { y: string }, _ctx: ToolContext): Promise<string> {
    return `beta:${args.y}`;
  }
}

@Tool()
class DuplicateAlphaTool implements MeshbotTool<{ x: number }, string> {
  readonly name = "alpha";
  readonly description = "Duplicate";
  readonly schema = z.object({ x: z.number() });
  async execute(args: { x: number }, _ctx: ToolContext): Promise<string> {
    return `dup:${args.x}`;
  }
}

class NotATool {
  hello() {
    return "world";
  }
}

function fakeDiscovery(instances: object[]): DiscoveryService {
  return {
    getProviders: () => instances.map((inst) => ({ instance: inst })) as never,
  } as unknown as DiscoveryService;
}

function makeMcpTool(name: string): MeshbotTool {
  return {
    name,
    description: `MCP tool ${name}`,
    schema: z.object({}),
    async execute() {
      return name;
    },
  };
}

function makeLcTool(name: string) {
  return createLcTool(async () => "", {
    name,
    description: `LC ${name}`,
    schema: z.object({}),
  });
}

describe("ToolRegistry — 按「账号+Agent」隔离 MCP 工具", () => {
  let account: AccountContextService;
  let agentCtx: AgentContextService;
  let registry: ToolRegistry;
  let toolA: MeshbotTool;
  let toolB: MeshbotTool;
  let lcToolA: ReturnType<typeof makeLcTool>;
  let lcToolB: ReturnType<typeof makeLcTool>;

  function makeRegistry(): ToolRegistry {
    const alpha = new FakeAlphaTool();
    const r = new ToolRegistry(fakeDiscovery([alpha]), account, agentCtx);
    r.onModuleInit();
    return r;
  }

  beforeEach(() => {
    account = new AccountContextService();
    agentCtx = new AgentContextService();
    registry = makeRegistry();
    toolA = makeMcpTool("tool-a");
    toolB = makeMcpTool("tool-b");
    lcToolA = makeLcTool("tool-a");
    lcToolB = makeLcTool("tool-b");
  });

  it("两个 Agent 的 MCP 工具互不可见", () => {
    registry.registerForAgent("acct-1", "agent-a", toolA, lcToolA);
    registry.registerForAgent("acct-1", "agent-b", toolB, lcToolB);
    account.run("acct-1", () => {
      agentCtx.run("agent-a", () => {
        const names = registry.asLangChainBindable().map((t) => t.name);
        expect(names).toContain("tool-a");
        expect(names).not.toContain("tool-b");
        expect(registry.get("tool-b")).toBeUndefined();
      });
      agentCtx.run("agent-b", () => {
        expect(registry.get("tool-b")).toBeDefined();
      });
    });
  });

  it("内置工具对所有 Agent 都可见", () => {
    account.run("acct-1", () => {
      agentCtx.run("agent-a", () => {
        expect(registry.get("alpha")).toBeDefined();
      });
    });
  });

  it("unregisterAccount 清掉该账号下全部 Agent 的工具", () => {
    registry.registerForAgent("acct-1", "agent-a", toolA, lcToolA);
    registry.registerForAgent("acct-1", "agent-b", toolB, lcToolB);
    registry.unregisterAccount("acct-1");
    account.run("acct-1", () => {
      agentCtx.run("agent-a", () => {
        expect(registry.get("tool-a")).toBeUndefined();
      });
      agentCtx.run("agent-b", () => {
        expect(registry.get("tool-b")).toBeUndefined();
      });
    });
  });

  it("unregisterAgent 只清掉该 Agent 的工具，兄弟 Agent 不受影响", () => {
    registry.registerForAgent("acct-1", "agent-a", toolA, lcToolA);
    registry.registerForAgent("acct-1", "agent-b", toolB, lcToolB);
    registry.unregisterAgent("acct-1", "agent-a");
    account.run("acct-1", () => {
      agentCtx.run("agent-a", () => {
        expect(registry.get("tool-a")).toBeUndefined();
      });
      agentCtx.run("agent-b", () => {
        expect(registry.get("tool-b")).toBeDefined();
      });
    });
  });

  it("同 Agent 重名工具覆盖（upsert）", () => {
    registry.registerForAgent("acct-1", "agent-a", toolA, lcToolA);
    const toolA2 = makeMcpTool("tool-a");
    registry.registerForAgent("acct-1", "agent-a", toolA2, lcToolA);
    account.run("acct-1", () => {
      agentCtx.run("agent-a", () => {
        expect(registry.get("tool-a")).toBe(toolA2);
      });
    });
  });

  it("缺账号或缺 Agent 上下文只见内置工具，不抛错", () => {
    registry.registerForAgent("acct-1", "agent-a", toolA, lcToolA);
    // 完全无上下文。
    expect(() => registry.list()).not.toThrow();
    expect(registry.list().map((t) => t.name)).toEqual(["alpha"]);
    // 只有账号，无 Agent。
    account.run("acct-1", () => {
      expect(() => registry.list()).not.toThrow();
      expect(registry.list().map((t) => t.name)).toEqual(["alpha"]);
    });
    // 只有 Agent，无账号。
    agentCtx.run("agent-a", () => {
      expect(() => registry.list()).not.toThrow();
      expect(registry.list().map((t) => t.name)).toEqual(["alpha"]);
    });
  });
});

describe("ToolRegistry", () => {
  const noopAccount = new AccountContextService();
  const noopAgent = new AgentContextService();

  it("onModuleInit 注册所有带 @Tool() 的 provider", () => {
    const alpha = new FakeAlphaTool();
    const beta = new FakeBetaTool();
    const other = new NotATool();
    const registry = new ToolRegistry(
      fakeDiscovery([alpha, beta, other]),
      noopAccount,
      noopAgent,
    );
    registry.onModuleInit();
    expect(registry.get("alpha")).toBe(alpha);
    expect(registry.get("beta")).toBe(beta);
    expect(
      registry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  it("重复 name 启动期抛错", () => {
    const a = new FakeAlphaTool();
    const dup = new DuplicateAlphaTool();
    const registry = new ToolRegistry(
      fakeDiscovery([a, dup]),
      noopAccount,
      noopAgent,
    );
    expect(() => registry.onModuleInit()).toThrow(/Duplicate tool name: alpha/);
  });

  it("asLangChainBindable 返回数组长度匹配 tool 数", () => {
    const alpha = new FakeAlphaTool();
    const beta = new FakeBetaTool();
    const registry = new ToolRegistry(
      fakeDiscovery([alpha, beta]),
      noopAccount,
      noopAgent,
    );
    registry.onModuleInit();
    const tools = registry.asLangChainBindable();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("get 不存在的 name 返 undefined", () => {
    const registry = new ToolRegistry(
      fakeDiscovery([new FakeAlphaTool()]),
      noopAccount,
      noopAgent,
    );
    registry.onModuleInit();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("register 动态加入 tool；unregister 移除", () => {
    const registry = new ToolRegistry(
      fakeDiscovery([new FakeAlphaTool()]),
      noopAccount,
      noopAgent,
    );
    registry.onModuleInit();
    const gamma: MeshbotTool<{ z: string }, string> = {
      name: "gamma",
      description: "Gamma tool",
      schema: z.object({ z: z.string() }),
      async execute(args) {
        return `gamma:${args.z}`;
      },
    };
    registry.register(gamma);
    expect(registry.get("gamma")).toBe(gamma);
    expect(registry.asLangChainBindable()).toHaveLength(2);
    registry.unregister("gamma");
    expect(registry.get("gamma")).toBeUndefined();
    expect(registry.asLangChainBindable()).toHaveLength(1);
  });

  it("register 重名抛错", () => {
    const registry = new ToolRegistry(
      fakeDiscovery([new FakeAlphaTool()]),
      noopAccount,
      noopAgent,
    );
    registry.onModuleInit();
    const dup: MeshbotTool<{ x: number }, string> = {
      name: "alpha",
      description: "dup",
      schema: z.object({ x: z.number() }),
      async execute() {
        return "x";
      },
    };
    expect(() => registry.register(dup)).toThrow(/Duplicate tool name: alpha/);
  });
});
