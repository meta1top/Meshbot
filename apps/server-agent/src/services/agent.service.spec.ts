import { DEFAULT_AGENT_NAME } from "@meshbot/types-agent";
import {
  AccountContextService,
  MeshbotConfigService,
} from "@meshbot/lib-agent";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { Agent } from "../entities/agent.entity";
import { AgentService } from "./agent.service";
import { SessionService } from "./session.service";

/** 造一份最小合法 AgentCreateInput，name 可覆盖。 */
function fixture(name: string) {
  return {
    name,
    avatar: "🤖|#f97316",
    description: "",
    systemPrompt: "",
    defaultModelConfigId: null,
  };
}

describe("AgentService", () => {
  let ds: DataSource;
  let service: AgentService;
  let account: AccountContextService;
  /** 假 SessionService：只记调用，验证 removeInDb 触达「找会话→逐个删」。 */
  let fakeSessions: {
    findByAgentId: jest.Mock;
    removeWithMessages: jest.Mock;
  };
  /** 假 MeshbotConfigService：只记 agentDirOf 调用，不碰真实磁盘。 */
  let fakeConfig: { agentDirOf: jest.Mock };

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Agent],
      synchronize: true,
    });
    await ds.initialize();
    fakeSessions = {
      findByAgentId: jest.fn().mockResolvedValue([]),
      removeWithMessages: jest.fn().mockResolvedValue(undefined),
    };
    fakeConfig = {
      agentDirOf: jest
        .fn()
        .mockReturnValue("/tmp/agent-service-spec-nonexistent"),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentService,
        AccountContextService,
        ScopedRepositoryFactory,
        {
          provide: getRepositoryToken(Agent),
          useValue: ds.getRepository(Agent),
        },
        { provide: MeshbotConfigService, useValue: fakeConfig },
        { provide: SessionService, useValue: fakeSessions },
      ],
    }).compile();
    service = moduleRef.get(AgentService);
    account = moduleRef.get(AccountContextService);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("create 后能按 id 查回，且带上当前账号", async () => {
    await account.run("acct-1", async () => {
      const created = await service.create({
        name: "研发助手",
        avatar: "🛠️|#3b82f6",
        description: "写代码",
        systemPrompt: "你是研发助手",
        defaultModelConfigId: null,
      });
      expect(created.id).toBeTruthy();
      const found = await service.findOrNull(created.id);
      expect(found?.name).toBe("研发助手");
      expect(found?.cloudUserId).toBe("acct-1");
      expect(found?.remoteEnabled).toBe(false);
      expect(found?.visibility).toBe("private");
    });
  });

  it("按账号隔离：另一个账号看不到", async () => {
    const id = await account.run("acct-1", () =>
      service
        .create({
          name: "A",
          avatar: "🅰️|#000000",
          description: "",
          systemPrompt: "",
          defaultModelConfigId: null,
        })
        .then((a) => a.id),
    );
    await account.run("acct-2", async () => {
      expect(await service.findOrNull(id)).toBeNull();
      expect(await service.list()).toHaveLength(0);
    });
  });

  it("ensureDefault：零 agent 时建默认 agent；已有时原样返回第一个", async () => {
    await account.run("acct-1", async () => {
      const first = await service.ensureDefault();
      expect(first.name).toBe(DEFAULT_AGENT_NAME);
      const again = await service.ensureDefault();
      expect(again.id).toBe(first.id);
      expect(await service.list()).toHaveLength(1);
    });
  });

  it("ensureDefault：并发调用只建一个默认 agent（in-flight 去重）", async () => {
    await account.run("acct-1", async () => {
      const [a, b] = await Promise.all([
        service.ensureDefault(),
        service.ensureDefault(),
      ]);
      expect(a.id).toBe(b.id);
      expect(await service.list()).toHaveLength(1);
    });
  });

  it("update 只改传入字段", async () => {
    await account.run("acct-1", async () => {
      const a = await service.create({
        name: "旧名",
        avatar: "🤖|#f97316",
        description: "描述",
        systemPrompt: "提示词",
        defaultModelConfigId: null,
      });
      const updated = await service.update(a.id, { name: "新名" });
      expect(updated.name).toBe("新名");
      expect(updated.systemPrompt).toBe("提示词");
      expect(updated.description).toBe("描述");
    });
  });

  describe("removeWithData / removeInDb", () => {
    it("删除前先删名下全部会话，再删 Agent 行", async () => {
      await account.run("acct-1", async () => {
        await service.ensureDefault(); // 保证不是最后一个
        const target = await service.create(fixture("待删"));
        fakeSessions.findByAgentId.mockResolvedValueOnce([
          { id: "s1" },
          { id: "s2" },
        ]);
        await service.removeWithData(target.id);
        expect(fakeSessions.findByAgentId).toHaveBeenCalledWith(target.id);
        expect(fakeSessions.removeWithMessages).toHaveBeenCalledWith("s1");
        expect(fakeSessions.removeWithMessages).toHaveBeenCalledWith("s2");
        expect(await service.findOrNull(target.id)).toBeNull();
      });
    });

    it("删除后按 id 定位磁盘目录（agentDirOf 非当前 Agent 也能取）", async () => {
      await account.run("acct-1", async () => {
        await service.ensureDefault();
        const target = await service.create(fixture("待删2"));
        await service.removeWithData(target.id);
        expect(fakeConfig.agentDirOf).toHaveBeenCalledWith(target.id);
      });
    });

    it("只剩一个 Agent 时拒绝删除，不落库、不动会话", async () => {
      await account.run("acct-1", async () => {
        const only = await service.ensureDefault();
        await expect(service.removeWithData(only.id)).rejects.toThrow(
          /至少保留一个/,
        );
        expect(await service.findOrNull(only.id)).not.toBeNull();
        expect(fakeSessions.removeWithMessages).not.toHaveBeenCalled();
      });
    });
  });

  describe("duplicate", () => {
    it("复制配置（名字加「(副本)」）但生成新 id", async () => {
      await account.run("acct-1", async () => {
        const src = await service.create({
          name: "源",
          avatar: "🛠️|#3b82f6",
          description: "desc",
          systemPrompt: "你是源 Agent",
          defaultModelConfigId: null,
        });
        const copy = await service.duplicate(src.id);
        expect(copy.id).not.toBe(src.id);
        expect(copy.name).toBe("源 (副本)");
        expect(copy.avatar).toBe(src.avatar);
        expect(copy.description).toBe(src.description);
        expect(copy.systemPrompt).toBe(src.systemPrompt);
      });
    });
  });

  describe("resolveOrDefault", () => {
    it("undefined → 兜底 ensureDefault", async () => {
      await account.run("acct-1", async () => {
        const resolved = await service.resolveOrDefault(undefined);
        expect(resolved.name).toBe(DEFAULT_AGENT_NAME);
      });
    });

    it("空字符串 → 同样兜底 ensureDefault（不能用 ?? 误判为已指定）", async () => {
      await account.run("acct-1", async () => {
        const resolved = await service.resolveOrDefault("");
        expect(resolved.name).toBe(DEFAULT_AGENT_NAME);
      });
    });

    it("显式合法 id → findOrThrow 返回该 Agent", async () => {
      await account.run("acct-1", async () => {
        const created = await service.create(fixture("显式"));
        const resolved = await service.resolveOrDefault(created.id);
        expect(resolved.id).toBe(created.id);
      });
    });

    it("越权 id（属于别的账号）→ 404，不静默兜底", async () => {
      const otherId = await account.run("acct-2", () =>
        service.create(fixture("别账号的")).then((a) => a.id),
      );
      await account.run("acct-3", async () => {
        await expect(service.resolveOrDefault(otherId)).rejects.toThrow(
          NotFoundException,
        );
      });
    });
  });
});
