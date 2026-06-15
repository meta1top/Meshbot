import { tool as createLcTool } from "@langchain/core/tools";
import { DiscoveryService } from "@nestjs/core";
import { z } from "zod";
import { AccountContextService } from "../account/account-context.service";
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

describe("ToolRegistry — per-account MCP 工具", () => {
  let ctx: AccountContextService;
  let registry: ToolRegistry;
  let mcpToolU1: MeshbotTool;
  let mcpToolU2: MeshbotTool;
  let lcU1: ReturnType<typeof makeLcTool>;
  let lcU2: ReturnType<typeof makeLcTool>;

  beforeEach(() => {
    ctx = new AccountContextService();
    const alpha = new FakeAlphaTool();
    registry = new ToolRegistry(fakeDiscovery([alpha]), ctx);
    registry.onModuleInit();
    mcpToolU1 = makeMcpTool("mcp-u1");
    mcpToolU2 = makeMcpTool("mcp-u2");
    lcU1 = makeLcTool("mcp-u1");
    lcU2 = makeLcTool("mcp-u2");
  });

  it("asLangChainBindable = 内置 + 当前账号 MCP 工具", () => {
    registry.registerForAccount("u1", mcpToolU1, lcU1);
    registry.registerForAccount("u2", mcpToolU2, lcU2);
    const u1 = ctx.run("u1", () => registry.list().map((t) => t.name));
    expect(u1).toContain("alpha");
    expect(u1).toContain(mcpToolU1.name);
    expect(u1).not.toContain(mcpToolU2.name);
  });

  it("无账号上下文只见内置工具（不抛错）", () => {
    registry.registerForAccount("u1", mcpToolU1, lcU1);
    expect(() => registry.list()).not.toThrow();
    expect(registry.list().map((t) => t.name)).not.toContain(mcpToolU1.name);
    expect(registry.list().map((t) => t.name)).toContain("alpha");
  });

  it("get(name) 解析当前账号 MCP 工具；他账号不可达", () => {
    registry.registerForAccount("u1", mcpToolU1, lcU1);
    expect(ctx.run("u2", () => registry.get(mcpToolU1.name))).toBeUndefined();
    expect(ctx.run("u1", () => registry.get(mcpToolU1.name))).toBeDefined();
  });

  it("unregisterAccount 清掉该账号 MCP 工具", () => {
    registry.registerForAccount("u1", mcpToolU1, lcU1);
    registry.unregisterAccount("u1");
    expect(ctx.run("u1", () => registry.get(mcpToolU1.name))).toBeUndefined();
  });
});

describe("ToolRegistry", () => {
  const noopCtx = new AccountContextService();

  it("onModuleInit 注册所有带 @Tool() 的 provider", () => {
    const alpha = new FakeAlphaTool();
    const beta = new FakeBetaTool();
    const other = new NotATool();
    const registry = new ToolRegistry(
      fakeDiscovery([alpha, beta, other]),
      noopCtx,
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
    const registry = new ToolRegistry(fakeDiscovery([a, dup]), noopCtx);
    expect(() => registry.onModuleInit()).toThrow(/Duplicate tool name: alpha/);
  });

  it("asLangChainBindable 返回数组长度匹配 tool 数", () => {
    const alpha = new FakeAlphaTool();
    const beta = new FakeBetaTool();
    const registry = new ToolRegistry(fakeDiscovery([alpha, beta]), noopCtx);
    registry.onModuleInit();
    const tools = registry.asLangChainBindable();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("get 不存在的 name 返 undefined", () => {
    const registry = new ToolRegistry(
      fakeDiscovery([new FakeAlphaTool()]),
      noopCtx,
    );
    registry.onModuleInit();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("register 动态加入 tool；unregister 移除", () => {
    const registry = new ToolRegistry(
      fakeDiscovery([new FakeAlphaTool()]),
      noopCtx,
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
      noopCtx,
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
