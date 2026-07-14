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
 * 测哲学：真连 MCP server 不现实，这里只锁定「按账号 init/teardown 的簿记 + 隔离」。
 * 用可注入的 createClient 工厂在测试子类里替换出 stub client：
 *   getTools() 返回假 LC tool，close() 是 spy。
 *
 * mcp.json 已下沉到 agents/<agentId>/ 下（Task 4），每个账号用固定的 AGENT_ID
 * 兜底（本测试只锁定账号级 init/teardown 簿记，不测多 Agent 场景）。
 */

const AGENT_ID = "agent-mcp-test";

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

function makeRegistry(account: AccountContextService): ToolRegistry {
  const r = new ToolRegistry(
    { getProviders: () => [] } as unknown as DiscoveryService,
    account,
  );
  r.onModuleInit();
  return r;
}

function writeMcpJson(home: string, cloudUserId: string, json: unknown): void {
  const dir = path.join(home, "accounts", cloudUserId, "agents", AGENT_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "mcp.json"), JSON.stringify(json), "utf8");
}

const ONE_SERVER = {
  mcpServers: {
    fs: { command: "echo", args: ["hi"] },
  },
};

describe("McpService 每账号 init/teardown", () => {
  let home: string;
  let account: AccountContextService;
  let agentCtx: AgentContextService;
  let config: MeshbotConfigService;
  let reg: ToolRegistry;
  let svc: TestMcpService;

  /** 在账号 + Agent 双层上下文中运行 fn（mcp.json 已下沉到 agents/<agentId>/ 下）。 */
  function runInContext<T>(cloudUserId: string, fn: () => T): T {
    return account.run(cloudUserId, () => agentCtx.run(AGENT_ID, fn));
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "meshbot-mcp-"));
    process.env.MESHBOT_HOME = home;
    account = new AccountContextService();
    agentCtx = new AgentContextService();
    config = new MeshbotConfigService(account, agentCtx);
    reg = makeRegistry(account);
    svc = new TestMcpService(config, reg);
  });

  afterEach(() => {
    process.env.MESHBOT_HOME = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("不实现 onModuleInit（启动期不自动加载）", () => {
    expect(
      (svc as unknown as { onModuleInit?: unknown }).onModuleInit,
    ).toBeUndefined();
  });

  it("initAccount 在账号上下文内读该账号 mcp.json，注册到 registerForAccount", async () => {
    writeMcpJson(home, "u1", ONE_SERVER);
    const stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
    svc.stubs = [stub];
    const spy = vi.spyOn(reg, "registerForAccount");

    await runInContext("u1", async () => {
      await svc.initAccount("u1");
    });

    expect(stub.getTools).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("u1");
    // 第二个参数是 meshbot adapter，name 透传自 LC tool。
    expect(spy.mock.calls[0][1].name).toBe("mcp__fs__read");
    // 该账号上下文下 registry.list() 能看到这颗工具。
    account.run("u1", () => {
      expect(reg.list().map((t) => t.name)).toContain("mcp__fs__read");
    });
  });

  it("无 mcp.json → no-op，不注册任何工具，不构造 client", async () => {
    const spy = vi.spyOn(reg, "registerForAccount");
    await runInContext("u1", async () => {
      await svc.initAccount("u1");
    });
    expect(spy).not.toHaveBeenCalled();
    expect(svc.createdServers).toHaveLength(0);
  });

  it("空 mcpServers → no-op，不构造 client", async () => {
    writeMcpJson(home, "u1", { mcpServers: {} });
    const spy = vi.spyOn(reg, "registerForAccount");
    await runInContext("u1", async () => {
      await svc.initAccount("u1");
    });
    expect(spy).not.toHaveBeenCalled();
    expect(svc.createdServers).toHaveLength(0);
  });

  it("teardownAccount → unregisterAccount + client.close + perAccount 清掉", async () => {
    writeMcpJson(home, "u1", ONE_SERVER);
    const stub = makeStubClient([fakeLcTool("mcp__fs__read")]);
    svc.stubs = [stub];
    await runInContext("u1", async () => {
      await svc.initAccount("u1");
    });

    const unregSpy = vi.spyOn(reg, "unregisterAccount");
    await svc.teardownAccount("u1");

    expect(unregSpy).toHaveBeenCalledWith("u1");
    expect(stub.close).toHaveBeenCalledTimes(1);
    // u1 上下文下不再有该工具。
    account.run("u1", () => {
      expect(reg.list().map((t) => t.name)).not.toContain("mcp__fs__read");
    });
    // 重复 teardown 幂等：close 不再被调（perAccount 已无 u1）。
    await svc.teardownAccount("u1");
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("teardown 未 init 的账号 → 安全 no-op", async () => {
    const unregSpy = vi.spyOn(reg, "unregisterAccount");
    await expect(svc.teardownAccount("nobody")).resolves.toBeUndefined();
    expect(unregSpy).not.toHaveBeenCalled();
  });

  it("initAccount 二次调用幂等：先 teardown 旧 client 再 re-init，无泄漏", async () => {
    writeMcpJson(home, "u1", ONE_SERVER);
    const first = makeStubClient([fakeLcTool("mcp__fs__read")]);
    const second = makeStubClient([fakeLcTool("mcp__fs__read")]);
    svc.stubs = [first, second];

    await runInContext("u1", async () => {
      await svc.initAccount("u1");
      await svc.initAccount("u1");
    });

    // 二次 init 前先关掉了第一个 client。
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.getTools).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect(svc.createdServers).toHaveLength(2);
  });

  it("两账号隔离：各自注册在自己的键下", async () => {
    writeMcpJson(home, "u1", {
      mcpServers: { fs: { command: "echo", args: ["u1"] } },
    });
    writeMcpJson(home, "u2", {
      mcpServers: { web: { command: "echo", args: ["u2"] } },
    });
    const s1 = makeStubClient([fakeLcTool("mcp__fs__read")]);
    const s2 = makeStubClient([fakeLcTool("mcp__web__fetch")]);
    svc.stubs = [s1, s2];

    await runInContext("u1", async () => {
      await svc.initAccount("u1");
    });
    await runInContext("u2", async () => {
      await svc.initAccount("u2");
    });

    account.run("u1", () => {
      const names = reg.list().map((t) => t.name);
      expect(names).toContain("mcp__fs__read");
      expect(names).not.toContain("mcp__web__fetch");
    });
    account.run("u2", () => {
      const names = reg.list().map((t) => t.name);
      expect(names).toContain("mcp__web__fetch");
      expect(names).not.toContain("mcp__fs__read");
    });
  });

  it("onModuleDestroy 拆掉所有账号的 client", async () => {
    writeMcpJson(home, "u1", {
      mcpServers: { fs: { command: "echo", args: ["u1"] } },
    });
    writeMcpJson(home, "u2", {
      mcpServers: { web: { command: "echo", args: ["u2"] } },
    });
    const s1 = makeStubClient([fakeLcTool("mcp__fs__read")]);
    const s2 = makeStubClient([fakeLcTool("mcp__web__fetch")]);
    svc.stubs = [s1, s2];
    await runInContext("u1", async () => svc.initAccount("u1"));
    await runInContext("u2", async () => svc.initAccount("u2"));

    await svc.onModuleDestroy();

    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(s2.close).toHaveBeenCalledTimes(1);
  });
});
