import { DiscoveryService } from "@nestjs/core";
import { z } from "zod";
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

describe("ToolRegistry", () => {
  it("onModuleInit 注册所有带 @Tool() 的 provider", () => {
    const alpha = new FakeAlphaTool();
    const beta = new FakeBetaTool();
    const other = new NotATool();
    const registry = new ToolRegistry(fakeDiscovery([alpha, beta, other]));
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
    const registry = new ToolRegistry(fakeDiscovery([a, dup]));
    expect(() => registry.onModuleInit()).toThrow(/Duplicate tool name: alpha/);
  });

  it("asLangChainBindable 返回数组长度匹配 tool 数", () => {
    const alpha = new FakeAlphaTool();
    const beta = new FakeBetaTool();
    const registry = new ToolRegistry(fakeDiscovery([alpha, beta]));
    registry.onModuleInit();
    const tools = registry.asLangChainBindable();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("get 不存在的 name 返 undefined", () => {
    const registry = new ToolRegistry(fakeDiscovery([new FakeAlphaTool()]));
    registry.onModuleInit();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("register 动态加入 tool；unregister 移除", () => {
    const registry = new ToolRegistry(fakeDiscovery([new FakeAlphaTool()]));
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
    const registry = new ToolRegistry(fakeDiscovery([new FakeAlphaTool()]));
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
