import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Logger } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { ToolRegistry } from "../tools/tool-registry";
import { McpService, mapServersToLangchainShape } from "./mcp.service";

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

describe("mapServersToLangchainShape 过滤 enabled===false", () => {
  it("显式 enabled:false 的 server 被过滤，不出现在 langchain shape 里", () => {
    const shape = mapServersToLangchainShape({
      fs: { command: "echo", args: ["hi"] },
      disabled: { command: "echo", args: ["bye"], enabled: false },
      remote: { url: "https://example.com/mcp", enabled: true },
    });
    expect(Object.keys(shape).sort()).toEqual(["fs", "remote"]);
  });

  it("enabled 缺省视为启用，不被过滤", () => {
    const shape = mapServersToLangchainShape({
      fs: { command: "echo", args: ["hi"] },
    });
    expect(shape.fs).toBeDefined();
  });
});

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
    svc = new TestMcpService(config, reg, account, agentCtx);
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
    const handle = svc.acquire("u1", "agent-a");

    await svc.sweepIdle(Date.now() + 31 * 60_000);
    expect(unregSpy).not.toHaveBeenCalled();
    expect(stub.close).not.toHaveBeenCalled();

    svc.release("u1", "agent-a", handle);
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
    const handle1 = svc.acquire("u1", "agent-a");
    const handle2 = svc.acquire("u1", "agent-a");

    svc.release("u1", "agent-a", handle1);
    await svc.sweepIdle(Date.now() + 31 * 60_000);
    expect(unregSpy).not.toHaveBeenCalled();
    expect(stub.close).not.toHaveBeenCalled();

    svc.release("u1", "agent-a", handle2);
    await svc.sweepIdle(Date.now() + 31 * 60_000);
    expect(unregSpy).toHaveBeenCalledWith("u1", "agent-a");
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("release() 传入不认识的 handle（stale / 已关闭）→ no-op + warn，不误伤当前运行态计数", async () => {
    writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
    const stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
    svc.stubs = [stub];
    const warnSpy = vi.spyOn(Logger.prototype, "warn");

    await runInContext("u1", "agent-a", () => svc.ensureAgent("u1", "agent-a"));
    const realHandle = svc.acquire("u1", "agent-a");
    const strangeHandle = {}; // 既不是当前 entry，也不在 retired 里

    svc.release("u1", "agent-a", strangeHandle);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("identity mismatch"),
    );

    // 当前运行态的真实引用计数不受影响：真正的 release 仍能正常回收。
    svc.release("u1", "agent-a", realHandle);
    await svc.sweepIdle(Date.now() + 31 * 60_000);
    expect(stub.close).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
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

  describe("updateConfig：读-改-写单一入口", () => {
    function mcpJsonPath(cloudUserId: string, agentId: string): string {
      return path.join(
        home,
        "accounts",
        cloudUserId,
        "agents",
        agentId,
        "mcp.json",
      );
    }

    it("mutator 产物 schema 校验失败 → 不落盘、不 teardown", async () => {
      const teardownSpy = vi.spyOn(svc, "teardownAgent");

      await runInContext("u1", "agent-a", async () => {
        await expect(
          svc.updateConfig(
            () =>
              ({
                mcpServers: { bad: { args: ["--help"] } },
              }) as never,
          ),
        ).rejects.toThrow();
      });

      expect(existsSync(mcpJsonPath("u1", "agent-a"))).toBe(false);
      expect(teardownSpy).not.toHaveBeenCalled();
    });

    it("mutator 产物合法 → 先落盘再 teardown（次序断言：teardown 触发时文件必已可见），且立即重建运行态（热生效，不再是失效等下次 run）", async () => {
      writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
      svc.stubs = [makeStubClient([fakeLcTool("mcp__fs__read")])];
      await runInContext("u1", "agent-a", () =>
        svc.ensureAgent("u1", "agent-a"),
      );
      expect(svc.getLoadedToolNames("u1", "agent-a")).not.toBeNull();

      const target = mcpJsonPath("u1", "agent-a");
      const teardownSpy = vi.spyOn(svc, "teardownAgent");
      // reload 会立即 ensureAgent 重建，需要给第二次 createClient 备一个 stub。
      const reloadedStub = makeStubClient([
        fakeLcTool("mcp__fs__read"),
        fakeLcTool("mcp__web__fetch"),
      ]);
      svc.stubs.push(reloadedStub);

      await runInContext("u1", "agent-a", () =>
        svc.updateConfig((cfg) => ({
          mcpServers: {
            ...cfg.mcpServers,
            web: { command: "echo", args: ["web"] },
          },
        })),
      );

      // teardown 被调用时，写盘早已完成——次序断言的关键点。
      const teardownCall = teardownSpy.mock.invocationCallOrder[0];
      expect(existsSync(target)).toBe(true);
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.mcpServers.web.command).toBe("echo");
      expect(teardownSpy).toHaveBeenCalledWith("u1", "agent-a");
      expect(teardownCall).toBeGreaterThan(0);

      // 热生效：运行态已立即用新配置重建（本轮对话内可见），不是失效等下次 run。
      expect(svc.createdServers).toHaveLength(2);
      const names = svc.getLoadedToolNames("u1", "agent-a");
      expect(names).not.toBeNull();
      expect([...(names ?? [])].sort()).toEqual([
        "mcp__fs__read",
        "mcp__web__fetch",
      ]);
    });

    it("reload 后新 client 连不上（getTools 抛错）→ updateConfig 不抛错、不回滚落盘，运行态退化为空", async () => {
      // Self-review 要求的降级路径：配置本身合法（schema 校验通过、已落盘），
      // 只是重建连接失败——不能让 updateConfig 向调用方抛错，否则看起来像
      // "写配置失败"，但实际上文件已经写好了，语义会前后矛盾。
      writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
      svc.stubs = [makeStubClient([fakeLcTool("mcp__fs__read")])];
      await runInContext("u1", "agent-a", () =>
        svc.ensureAgent("u1", "agent-a"),
      );

      const target = mcpJsonPath("u1", "agent-a");
      svc.stubs.push(makeFailingStubClient(new Error("handshake failed")));

      await runInContext("u1", "agent-a", () =>
        svc.updateConfig((cfg) => ({
          mcpServers: {
            ...cfg.mcpServers,
            web: { command: "echo", args: ["broken"] },
          },
        })),
      );

      // 落盘已经成功，不回滚。
      expect(existsSync(target)).toBe(true);
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.mcpServers.web.command).toBe("echo");
      // 运行态已登记（非 null），但工具集为空——重建失败的既有降级语义。
      const names = svc.getLoadedToolNames("u1", "agent-a");
      expect(names).not.toBeNull();
      expect([...(names ?? [])]).toEqual([]);
    });

    it("并发不变量：run 持旧 entry 期间 updateConfig 触发 reload，旧 entry release 不影响新 entry 计数，旧 client 在归零后才 close", async () => {
      // 复现 brief 里描述的核心风险：teardownAgent 把旧 entry 移出 perAgent
      // 后，若 release() 仍按 key 查 perAgent，会错误地扣减「reload 后新建的
      // entry」的引用计数——本用例锁定修复后的正确行为（按身份精确匹配）。
      writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
      const oldStub = makeStubClient([fakeLcTool("mcp__fs__read")]);
      svc.stubs = [oldStub];
      await runInContext("u1", "agent-a", () =>
        svc.ensureAgent("u1", "agent-a"),
      );

      // 模拟 RunnerService：run 开始时 acquire 并保存 handle，之后才在 run
      // 内部调用 mcp_install 之类的写工具触发 reload。
      const oldHandle = svc.acquire("u1", "agent-a");

      const newStub = makeStubClient([
        fakeLcTool("mcp__fs__read"),
        fakeLcTool("mcp__web__fetch"),
      ]);
      svc.stubs.push(newStub);
      await runInContext("u1", "agent-a", () =>
        svc.updateConfig((cfg) => ({
          mcpServers: {
            ...cfg.mcpServers,
            web: { command: "echo", args: ["web"] },
          },
        })),
      );

      // reload 已经切到新 entry：清单立即热更新，旧 client 尚未关闭（run 仍在用）。
      const namesAfterReload = svc.getLoadedToolNames("u1", "agent-a");
      expect([...(namesAfterReload ?? [])].sort()).toEqual([
        "mcp__fs__read",
        "mcp__web__fetch",
      ]);
      expect(oldStub.close).not.toHaveBeenCalled();

      // 旧 run 结束，release(oldHandle)：应该精确命中旧（retired）entry，不影响新 entry。
      svc.release("u1", "agent-a", oldHandle);
      expect(oldStub.close).toHaveBeenCalledTimes(1);
      expect(newStub.close).not.toHaveBeenCalled();

      // 证明新 entry 的引用计数没有被旧 run 的 release 污染：接下来对它走一遍
      // 标准的 acquire → sweepIdle（有引用不回收）→ release → sweepIdle（回收）
      // 流程，行为应与「从未发生过 reload」的普通 entry 完全一致。若新 entry
      // 的计数被污染成非 0 值，这里的 acquire/release 配对会立刻错位。
      const newHandle = svc.acquire("u1", "agent-a");
      await svc.sweepIdle(Date.now() + 31 * 60_000);
      expect(newStub.close).not.toHaveBeenCalled();
      svc.release("u1", "agent-a", newHandle);
      await svc.sweepIdle(Date.now() + 62 * 60_000);
      expect(newStub.close).toHaveBeenCalledTimes(1);
    });

    it("身份精确匹配：entry1 被 run A/D 共享，D 触发 reload 后 run C（持 entry2）先于 A release——A 未 release 前 entry1 不得被关闭，C 的 release 精确落在 entry2 上", async () => {
      // 复现审查指出的 FIFO 猜测路由风险：entry1 = run A、run D 共享
      // （refCount=2）；D 在自己的工具调用里触发 reload → entry1 挂起
      // retired（refCount 仍是 2，reload 本身不消费任何引用）；D 结束后
      // release，entry1 降到 1（A 仍在用）。此时一个与这次 reload 完全
      // 无关、在 reload 之后才 acquire 了新 entry2 的 run C 提前结束
      // release——旧版按 key 猜测的 FIFO 策略会把这次 release 误路由到
      // entry1（最老的挂起条目），把它砍到 0 并提前 close，而 A 还在用它！
      // 身份匹配版本必须保证：C 的 release 只会命中它自己 acquire 到的
      // entry2，entry1 在 A 真正 release 之前绝不会被关闭。
      writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
      const entry1Stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
      svc.stubs = [entry1Stub];
      await runInContext("u1", "agent-a", () =>
        svc.ensureAgent("u1", "agent-a"),
      );

      // run A 与 run D 共享 entry1：各自 acquire 一次，refCount=2。
      const handleA = svc.acquire("u1", "agent-a");
      const handleD = svc.acquire("u1", "agent-a");

      // run D 在自己的工具调用里触发 reload（entry1 refCount=2>0 → 挂起 retired）。
      const entry2Stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
      svc.stubs.push(entry2Stub);
      await runInContext("u1", "agent-a", () => svc.updateConfig((cfg) => cfg));
      expect(entry1Stub.close).not.toHaveBeenCalled();

      // run D 结束，release(handleD)：entry1 从 2 降到 1（A 仍在用，不能关）。
      svc.release("u1", "agent-a", handleD);
      expect(entry1Stub.close).not.toHaveBeenCalled();

      // 与这次 reload 无关的 run C：在 reload 之后才开始，acquire 到的是
      // entry2；C 先于 A 结束，release(handleC)。
      const handleC = svc.acquire("u1", "agent-a");
      svc.release("u1", "agent-a", handleC);

      // 核心断言：entry1（A 仍持有）不受 C 的 release 影响，绝不能被关闭；
      // entry2（C 自己 acquire 的那个）也不该被 C 自己的 release 关闭
      // （release 只递减，不主动 close 当前 entry——交给 sweepIdle）。
      expect(entry1Stub.close).not.toHaveBeenCalled();
      expect(entry2Stub.close).not.toHaveBeenCalled();

      // 最后 run A 结束，release(handleA)：entry1 才真正降到 0 并 close。
      svc.release("u1", "agent-a", handleA);
      expect(entry1Stub.close).toHaveBeenCalledTimes(1);
      expect(entry2Stub.close).not.toHaveBeenCalled();
    });

    it("并发安全网：teardown 后 retired 条目卡住超过闲置阈值未 release，sweepIdle 强制关闭避免永久泄漏", async () => {
      writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
      const oldStub = makeStubClient([fakeLcTool("mcp__fs__read")]);
      svc.stubs = [oldStub];
      await runInContext("u1", "agent-a", () =>
        svc.ensureAgent("u1", "agent-a"),
      );
      svc.acquire("u1", "agent-a");

      svc.stubs.push(makeStubClient([fakeLcTool("mcp__fs__read")]));
      await runInContext("u1", "agent-a", () => svc.updateConfig((cfg) => cfg));

      // 模拟调用方 bug：一直不 release，refCount 永远卡在 1。
      expect(oldStub.close).not.toHaveBeenCalled();
      await svc.sweepIdle(Date.now() + 31 * 60_000);
      // 安全网触发：超过闲置阈值强制关闭，即使 refCount 仍 > 0。
      expect(oldStub.close).toHaveBeenCalledTimes(1);
    });

    it("无文件时 mutator 拿到空配置（mcpServers: {}）", async () => {
      let seen: unknown;
      await runInContext("u1", "agent-a", () =>
        svc.updateConfig((cfg) => {
          seen = cfg;
          return cfg;
        }),
      );
      expect(seen).toEqual({ mcpServers: {} });
    });
  });

  describe("getLoadedToolNames", () => {
    it("未加载过的 Agent 返回 null", () => {
      expect(svc.getLoadedToolNames("u1", "agent-a")).toBeNull();
    });

    it("已加载的 Agent 返回工具名集合", async () => {
      writeMcpJson(home, "u1", "agent-a", ONE_SERVER);
      svc.stubs = [makeStubClient([fakeLcTool("mcp__fs__read")])];
      await runInContext("u1", "agent-a", () =>
        svc.ensureAgent("u1", "agent-a"),
      );

      const names = svc.getLoadedToolNames("u1", "agent-a");
      expect(names).not.toBeNull();
      expect([...(names ?? [])]).toEqual(["mcp__fs__read"]);
    });
  });
});
