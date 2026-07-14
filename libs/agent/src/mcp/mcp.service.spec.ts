import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiscoveryService } from "@nestjs/core";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { ToolRegistry } from "../tools/tool-registry";
import { McpService } from "./mcp.service";

/**
 * 测哲学：真连 MCP server 不现实，这里只锁定「按 Agent 懒加载 + 引用计数 +
 * 闲置回收」的簿记 + 隔离。用可注入的 createClient 工厂在测试子类里替换出
 * stub client：getTools() 返回假 LC tool，close() 是 spy。
 *
 * mcp.json 已下沉到 agents/<agentId>/ 下（Task 4）；本轮（Task 6）把
 * McpService 从「登录时一次性起账号全部 MCP」改成「按 Agent 懒加载」，
 * 测试直接构造多个 agentId 覆盖隔离场景。
 */

/** 造一个最小可用的假 LC tool（name 唯一即可，schema/desc 透传给 adapter）。 */
function fakeLcTool(name: string): StructuredToolInterface {
  return {
    name,
    description: `fake ${name}`,
    invoke: vi.fn(async () => ""),
  } as unknown as StructuredToolInterface;
}

/** stub MultiServerMCPClient：可控的 getTools + 可观测的 close。 */
function makeStubClient(tools: StructuredToolInterface[]): {
  client: MultiServerMCPClient;
  close: ReturnType<typeof vi.fn>;
  getTools: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(async () => {});
  const getTools = vi.fn(async () => tools);
  const client = { getTools, close } as unknown as MultiServerMCPClient;
  return { client, close, getTools };
}

/**
 * 造一个 getTools 延时 resolve 的 stub client，模拟真实 stdio MCP 握手要
 * 几百 ms 到几秒的耗时，用来在测试里制造 check-then-act 的并发竞态窗口。
 */
function makeDelayedStubClient(
  tools: StructuredToolInterface[],
  delayMs: number,
): {
  client: MultiServerMCPClient;
  close: ReturnType<typeof vi.fn>;
  getTools: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(async () => {});
  const getTools = vi.fn(
    () =>
      new Promise<StructuredToolInterface[]>((resolve) => {
        setTimeout(() => resolve(tools), delayMs);
      }),
  );
  const client = { getTools, close } as unknown as MultiServerMCPClient;
  return { client, close, getTools };
}

/** 造一个 getTools 直接 reject 的 stub client，模拟 MCP 握手失败。 */
function makeFailingStubClient(error: Error): {
  client: MultiServerMCPClient;
  close: ReturnType<typeof vi.fn>;
  getTools: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(async () => {});
  const getTools = vi.fn(async () => {
    throw error;
  });
  const client = { getTools, close } as unknown as MultiServerMCPClient;
  return { client, close, getTools };
}

/**
 * 测试子类：覆盖 createClient 工厂，记录每次构造时拿到的 server 形状，
 * 并返回外部预置的 stub client（按构造顺序取）。
 */
class TestMcpService extends McpService {
  public stubs: ReturnType<typeof makeStubClient>[] = [];
  public createdServers: Record<string, Record<string, unknown>>[] = [];

  protected override createClient(
    servers: Record<string, Record<string, unknown>>,
  ): MultiServerMCPClient {
    this.createdServers.push(servers);
    const next = this.stubs.shift();
    if (!next) {
      throw new Error("TestMcpService: no stub client queued");
    }
    return next.client;
  }
}

function makeRegistry(
  account: AccountContextService,
  agentCtx: AgentContextService,
): ToolRegistry {
  const r = new ToolRegistry(
    { getProviders: () => [] } as unknown as DiscoveryService,
    account,
    agentCtx,
  );
  r.onModuleInit();
  return r;
}

function writeMcpJson(
  home: string,
  cloudUserId: string,
  agentId: string,
  json: unknown,
): void {
  const dir = path.join(home, "accounts", cloudUserId, "agents", agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "mcp.json"), JSON.stringify(json), "utf8");
}

const ONE_SERVER = {
  mcpServers: {
    fs: { command: "echo", args: ["hi"] },
  },
};

describe("McpService 按 Agent 懒加载 + 引用计数 + 闲置回收", () => {
  let home: string;
  let account: AccountContextService;
  let agentCtx: AgentContextService;
  let config: MeshbotConfigService;
  let reg: ToolRegistry;
  let svc: TestMcpService;

  /** 在账号 + Agent 双层上下文中运行 fn（mcp.json 已下沉到 agents/<agentId>/ 下）。 */
  function runInContext<T>(
    cloudUserId: string,
    agentId: string,
    fn: () => T,
  ): T {
    return account.run(cloudUserId, () => agentCtx.run(agentId, fn));
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "meshbot-mcp-"));
    process.env.MESHBOT_HOME = home;
    account = new AccountContextService();
    agentCtx = new AgentContextService();
    config = new MeshbotConfigService(account, agentCtx);
    reg = makeRegistry(account, agentCtx);
    svc = new TestMcpService(config, reg);
  });

  afterEach(async () => {
    await svc.onModuleDestroy();
    process.env.MESHBOT_HOME = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("ensureAgent 幂等：重复调用只 init 一次", async () => {
    writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
    svc.stubs = [makeStubClient([fakeLcTool("mcp__fs__read")])];

    await runInContext("u1", "agent-a", async () => {
      await svc.ensureAgent("u1", "agent-a");
      await svc.ensureAgent("u1", "agent-a");
    });

    expect(svc.createdServers).toHaveLength(1);
  });

  it("并发 ensureAgent（同一 Agent）应 in-flight 去重：createClient 只调用 1 次，不泄漏子进程", async () => {
    // Critical 复现：ensureAgent 的 check-then-act 之间隔着 await client.getTools()
    // 的巨大时间窗口（真实 stdio 握手要几百 ms 到几秒）。同一 Agent 被两个会话
    // （多标签页 / 主会话+子代理）几乎同时首次使用时，若没有 in-flight 去重，
    // 两次调用都会各自 createClient 拉起一个子进程，后完成的那次覆盖 perAgent，
    // 先起来的那个 client 从此在 perAgent 里不可见——teardown* 系列全靠
    // perAgent 定位目标，永远够不到它，子进程泄漏到进程退出。
    writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
    const stubA = makeDelayedStubClient([fakeLcTool("mcp__fs__read")], 20);
    const stubB = makeDelayedStubClient([fakeLcTool("mcp__fs__read")], 20);
    svc.stubs = [stubA, stubB];

    await runInContext("u1", "agent-a", () =>
      Promise.all([
        svc.ensureAgent("u1", "agent-a"),
        svc.ensureAgent("u1", "agent-a"),
      ]),
    );

    expect(svc.createdServers).toHaveLength(1);

    await svc.teardownAccount("u1");
    expect(stubA.close).toHaveBeenCalledTimes(1);
    expect(stubB.close).not.toHaveBeenCalled();
  });

  it("两个 Agent 各起各的 client，工具注册到各自名下", async () => {
    writeMcpJson(home, "u1", "agent-a", {
      mcpServers: { fs: { command: "echo", args: ["a"] } },
    });
    writeMcpJson(home, "u1", "agent-b", {
      mcpServers: { web: { command: "echo", args: ["b"] } },
    });
    const sa = makeStubClient([fakeLcTool("mcp__fs__read")]);
    const sb = makeStubClient([fakeLcTool("mcp__web__fetch")]);
    svc.stubs = [sa, sb];
    const spy = vi.spyOn(reg, "registerForAgent");

    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    await runInContext("u1", "agent-b", () => svc.ensureAgent("u1", "agent-b"));

    expect(svc.createdServers).toHaveLength(2);
    expect(spy).toHaveBeenCalledWith(
      "u1",
      "agent-a",
      expect.anything(),
      expect.anything(),
    );
    expect(spy).toHaveBeenCalledWith(
      "u1",
      "agent-b",
      expect.anything(),
      expect.anything(),
    );
    runInContext("u1", "agent-a", () => {
      const names = reg.list().map((t) => t.name);
      expect(names).toContain("mcp__fs__read");
      expect(names).not.toContain("mcp__web__fetch");
    });
    runInContext("u1", "agent-b", () => {
      const names = reg.list().map((t) => t.name);
      expect(names).toContain("mcp__web__fetch");
      expect(names).not.toContain("mcp__fs__read");
    });
  });

  it("无 mcp.json → 仍登记空运行态，不构造 client，重复 ensureAgent 不重试读盘", async () => {
    await runInContext("u1", "agent-a", async () => {
      await svc.ensureAgent("u1", "agent-a");
      await svc.ensureAgent("u1", "agent-a");
    });
    expect(svc.createdServers).toHaveLength(0);
  });

  it("空 mcpServers → 登记空运行态，不构造 client", async () => {
    writeMcpJson(home, "u1", "agent-a", { mcpServers: {} });
    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    expect(svc.createdServers).toHaveLength(0);
  });

  it("client.getTools() 抛错 → 登记空运行态，且已建出的 client 被 close 掉", async () => {
    writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
    const failing = makeFailingStubClient(new Error("handshake failed"));
    svc.stubs = [failing];
    const registerSpy = vi.spyOn(reg, "registerForAgent");

    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));

    // 已建出的 client 要被 best-effort close 掉，不能泄漏子进程。
    expect(failing.close).toHaveBeenCalledTimes(1);
    expect(registerSpy).not.toHaveBeenCalled();

    // 空运行态已登记：重复 ensureAgent 不重新读盘 / 不重新 createClient。
    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    expect(svc.createdServers).toHaveLength(1);
  });

  it("sweepIdle 回收闲置且无活跃 run 的 Agent", async () => {
    writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
    const stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
    svc.stubs = [stub];
    const unregSpy = vi.spyOn(reg, "unregisterAgent");

    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    await svc.sweepIdle(Date.now() + 31 * 60_000);

    expect(unregSpy).toHaveBeenCalledWith("u1", "agent-a");
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("sweepIdle 不回收有活跃 run 的 Agent（refCount > 0），release 后才回收", async () => {
    writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
    const stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
    svc.stubs = [stub];
    const unregSpy = vi.spyOn(reg, "unregisterAgent");

    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    svc.acquire("u1", "agent-a");

    await svc.sweepIdle(Date.now() + 31 * 60_000);
    expect(unregSpy).not.toHaveBeenCalled();
    expect(stub.close).not.toHaveBeenCalled();

    svc.release("u1", "agent-a");
    await svc.sweepIdle(Date.now() + 31 * 60_000);
    expect(unregSpy).toHaveBeenCalledWith("u1", "agent-a");
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("双重 acquire 只 release 一次仍受回收保护，release 两次后才允许回收", async () => {
    writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
    const stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
    svc.stubs = [stub];
    const unregSpy = vi.spyOn(reg, "unregisterAgent");

    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    svc.acquire("u1", "agent-a");
    svc.acquire("u1", "agent-a");

    svc.release("u1", "agent-a");
    await svc.sweepIdle(Date.now() + 31 * 60_000);
    expect(unregSpy).not.toHaveBeenCalled();
    expect(stub.close).not.toHaveBeenCalled();

    svc.release("u1", "agent-a");
    await svc.sweepIdle(Date.now() + 31 * 60_000);
    expect(unregSpy).toHaveBeenCalledWith("u1", "agent-a");
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("sweepIdle 未超过闲置阈值时不回收", async () => {
    writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
    const stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
    svc.stubs = [stub];
    const unregSpy = vi.spyOn(reg, "unregisterAgent");

    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    await svc.sweepIdle(Date.now() + 10 * 60_000);

    expect(unregSpy).not.toHaveBeenCalled();
    expect(stub.close).not.toHaveBeenCalled();
  });

  it("teardownAgent → unregisterAgent + client.close，幂等", async () => {
    writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
    const stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
    svc.stubs = [stub];
    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));

    await svc.teardownAgent("u1", "agent-a");
    expect(stub.close).toHaveBeenCalledTimes(1);
    runInContext("u1", "agent-a", () => {
      expect(reg.list().map((t) => t.name)).not.toContain("mcp__fs__read");
    });

    // 重复 teardown 幂等：close 不再被调。
    await svc.teardownAgent("u1", "agent-a");
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("teardownAgent 对空运行态（client:null）安全 no-op close", async () => {
    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    await expect(svc.teardownAgent("u1", "agent-a")).resolves.toBeUndefined();
  });

  it("teardown 未 ensureAgent 过的 Agent → 安全 no-op", async () => {
    const unregSpy = vi.spyOn(reg, "unregisterAgent");
    await expect(
      svc.teardownAgent("nobody", "agent-x"),
    ).resolves.toBeUndefined();
    expect(unregSpy).not.toHaveBeenCalled();
  });

  it("teardownAccount 拆掉该账号全部 Agent，不影响其他账号", async () => {
    writeMcpJson(home, "u1", "agent-a", {
      mcpServers: { fs: { command: "echo", args: ["a"] } },
    });
    writeMcpJson(home, "u1", "agent-b", {
      mcpServers: { web: { command: "echo", args: ["b"] } },
    });
    writeMcpJson(home, "u2", "agent-c", {
      mcpServers: { other: { command: "echo", args: ["c"] } },
    });
    const sa = makeStubClient([fakeLcTool("mcp__fs__read")]);
    const sb = makeStubClient([fakeLcTool("mcp__web__fetch")]);
    const sc = makeStubClient([fakeLcTool("mcp__other__x")]);
    svc.stubs = [sa, sb, sc];

    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    await runInContext("u1", "agent-b", () => svc.ensureAgent("u1", "agent-b"));
    await runInContext("u2", "agent-c", () => svc.ensureAgent("u2", "agent-c"));

    await svc.teardownAccount("u1");

    expect(sa.close).toHaveBeenCalledTimes(1);
    expect(sb.close).toHaveBeenCalledTimes(1);
    expect(sc.close).not.toHaveBeenCalled();
    runInContext("u2", "agent-c", () => {
      expect(reg.list().map((t) => t.name)).toContain("mcp__other__x");
    });
  });

  it("onModuleDestroy 拆掉所有 Agent 的 client", async () => {
    writeMcpJson(home, "u1", "agent-a", {
      mcpServers: { fs: { command: "echo", args: ["a"] } },
    });
    writeMcpJson(home, "u2", "agent-c", {
      mcpServers: { other: { command: "echo", args: ["c"] } },
    });
    const s1 = makeStubClient([fakeLcTool("mcp__fs__read")]);
    const s2 = makeStubClient([fakeLcTool("mcp__other__x")]);
    svc.stubs = [s1, s2];
    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    await runInContext("u2", "agent-c", () => svc.ensureAgent("u2", "agent-c"));

    await svc.onModuleDestroy();

    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(s2.close).toHaveBeenCalledTimes(1);
  });

  it("onModuleDestroy 应 clearInterval 停掉 sweep 定时器（防误删回归）", async () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    svc.onModuleInit();

    await svc.onModuleDestroy();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    clearIntervalSpy.mockRestore();
  });

  it("onModuleInit 起一个 unref 的定时器扫描闲置", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    svc.onModuleInit();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const timer = setIntervalSpy.mock.results[0]?.value as {
      unref?: () => void;
      hasRef?: () => boolean;
    };
    expect(typeof timer.unref).toBe("function");
    setIntervalSpy.mockRestore();
  });
});
