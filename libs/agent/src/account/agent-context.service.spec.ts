import { AgentContextService } from "./agent-context.service";

describe("AgentContextService", () => {
  it("run 内可读到 agentId，run 外为 null", () => {
    const svc = new AgentContextService();
    expect(svc.get()).toBeNull();
    svc.run("agent-1", () => {
      expect(svc.get()).toBe("agent-1");
    });
    expect(svc.get()).toBeNull();
  });

  it("getOrThrow 在无上下文时抛错", () => {
    const svc = new AgentContextService();
    expect(() => svc.getOrThrow()).toThrow(/无活跃 Agent 上下文/);
  });

  it("异步连续体自动继承", async () => {
    const svc = new AgentContextService();
    await svc.run("agent-2", async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(svc.get()).toBe("agent-2");
    });
  });

  it("嵌套 run 内层覆盖外层，退出后恢复", () => {
    const svc = new AgentContextService();
    svc.run("outer", () => {
      svc.run("inner", () => {
        expect(svc.get()).toBe("inner");
      });
      expect(svc.get()).toBe("outer");
    });
  });
});
