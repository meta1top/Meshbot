import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service.js";
import { AgentContextService } from "../../src/account/agent-context.service.js";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service.js";

function makeService(): {
  service: MeshbotConfigService;
  account: AccountContextService;
  agentCtx: AgentContextService;
} {
  const account = new AccountContextService();
  const agentCtx = new AgentContextService();
  return {
    service: new MeshbotConfigService(account, agentCtx),
    account,
    agentCtx,
  };
}

describe("MeshbotConfigService", () => {
  it("returns meshbot directory path", () => {
    const dir = makeService().service.getMeshbotDir();
    expect(typeof dir).toBe("string");
    expect(dir).toContain(".meshbot");
  });

  it("returns database path（共享，不依赖账号上下文）", () => {
    const dbPath = makeService().service.getDatabasePath();
    expect(dbPath).toContain(".meshbot");
    expect(dbPath).toContain("main.db");
  });

  it("prompt 目录需账号上下文，无上下文抛错", () => {
    expect(() => makeService().service.getPromptDir()).toThrow();
  });

  it("prompt 目录落在 accounts/<account> 下", () => {
    const { service, account } = makeService();
    account.run("acc-1", () => {
      const dir = service.getPromptDir();
      expect(dir).toContain(".meshbot");
      expect(dir).toContain(path.join("accounts", "acc-1", "prompt"));
    });
  });

  it("四个 Agent 化路径落在 agents/<agentId>/ 下", () => {
    const { service, account, agentCtx } = makeService();
    account.run("acct-1", () => {
      agentCtx.run("agent-9", () => {
        const agentRoot = path.join(
          service.getMeshbotDir(),
          "accounts",
          "acct-1",
          "agents",
          "agent-9",
        );
        expect(service.getSkillsDir()).toBe(path.join(agentRoot, "skills"));
        expect(service.getMemoryDir()).toBe(path.join(agentRoot, "memory"));
        expect(service.getWorkspaceDir()).toBe(
          path.join(agentRoot, "workspace"),
        );
        expect(service.getMcpConfigPath()).toBe(
          path.join(agentRoot, "mcp.json"),
        );
      });
    });
  });

  it("db 路径保持账号级，不下沉", () => {
    const { service, account, agentCtx } = makeService();
    account.run("acct-1", () => {
      agentCtx.run("agent-9", () => {
        expect(service.getAccountCheckpointDbPath()).toBe(
          path.join(service.getMeshbotDir(), "accounts", "acct-1", "agent.db"),
        );
        expect(service.getDatabasePath()).toBe(
          path.join(service.getMeshbotDir(), "main.db"),
        );
      });
    });
  });

  it("无 Agent 上下文时 Agent 化 getter 抛错", () => {
    const { service, account } = makeService();
    account.run("acct-1", () => {
      expect(() => service.getSkillsDir()).toThrow(/无活跃 Agent 上下文/);
    });
  });
});

describe("MeshbotConfigService MESHBOT_HOME 覆盖", () => {
  const original = process.env.MESHBOT_HOME;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MESHBOT_HOME;
    } else {
      process.env.MESHBOT_HOME = original;
    }
  });

  it("设了 MESHBOT_HOME 后，共享路径落在该目录下；Agent 化路径落在 accounts/<account>/agents/<agentId>", () => {
    const root = "/tmp/meshbot-per-account-test-home";
    process.env.MESHBOT_HOME = root;

    const account = new AccountContextService();
    const agentCtx = new AgentContextService();
    const service = new MeshbotConfigService(account, agentCtx);

    expect(service.getMeshbotDir()).toBe(root);
    expect(service.getDatabasePath()).toBe(path.join(root, "main.db"));

    account.run("acc-1", () => {
      expect(service.getPromptDir()).toBe(
        path.join(root, "accounts", "acc-1", "prompt"),
      );
      agentCtx.run("agent-1", () => {
        const agentRoot = path.join(
          root,
          "accounts",
          "acc-1",
          "agents",
          "agent-1",
        );
        expect(service.getMcpConfigPath()).toBe(
          path.join(agentRoot, "mcp.json"),
        );
        expect(service.getSkillsDir()).toBe(path.join(agentRoot, "skills"));
      });
    });
  });

  it("getAccountCheckpointDbPath 在账号上下文内返 accounts/<id>/agent.db", () => {
    const root = "/tmp/meshbot-checkpoint-db-test-home";
    process.env.MESHBOT_HOME = root;

    const account = new AccountContextService();
    const agentCtx = new AgentContextService();
    const service = new MeshbotConfigService(account, agentCtx);

    account.run("acc-1", () => {
      const p = service.getAccountCheckpointDbPath();
      expect(p).toBe(path.join(root, "accounts", "acc-1", "agent.db"));
    });
  });

  it("getAccountCheckpointDbPath 无账号上下文抛错", () => {
    const account = new AccountContextService();
    const agentCtx = new AgentContextService();
    const service = new MeshbotConfigService(account, agentCtx);
    expect(() => service.getAccountCheckpointDbPath()).toThrow();
  });
});
