import { DEFAULT_AGENT_NAME } from "@meshbot/types-agent";
import { AccountContextService } from "@meshbot/lib-agent";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { Agent } from "../entities/agent.entity";
import { AgentService } from "./agent.service";

describe("AgentService", () => {
  let ds: DataSource;
  let service: AgentService;
  let account: AccountContextService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Agent],
      synchronize: true,
    });
    await ds.initialize();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentService,
        AccountContextService,
        ScopedRepositoryFactory,
        {
          provide: getRepositoryToken(Agent),
          useValue: ds.getRepository(Agent),
        },
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

  it("remove 后查不到", async () => {
    await account.run("acct-1", async () => {
      const a = await service.create({
        name: "临时",
        avatar: "🤖|#f97316",
        description: "",
        systemPrompt: "",
        defaultModelConfigId: null,
      });
      await service.remove(a.id);
      expect(await service.findOrNull(a.id)).toBeNull();
    });
  });
});
