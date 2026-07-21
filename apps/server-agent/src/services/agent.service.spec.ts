import {
  AGENT_EVENTS,
  DEFAULT_AGENT_NAME,
  SESSION_LIFECYCLE_EVENTS,
} from "@meshbot/types-agent";
import {
  AccountContextService,
  MeshbotConfigService,
} from "@meshbot/lib-agent";
import { NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
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
  /** 假 EventEmitter2：断言 AGENT_EVENTS.changed 的发射时机与负载。 */
  let emitter: { emit: jest.Mock };
  /** 按顺序收集全部发射，供生命周期事件的时机/顺序断言。 */
  let emitted: Array<[string, unknown]>;

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
      // 返回 agentId（不再自己发 session.deleted，改由 removeWithData 事务外发）
      removeWithMessages: jest.fn().mockResolvedValue("agent-x"),
    };
    fakeConfig = {
      agentDirOf: jest
        .fn()
        .mockReturnValue("/tmp/agent-service-spec-nonexistent"),
    };
    emitted = [];
    emitter = {
      emit: jest.fn((event: string, payload: unknown) => {
        emitted.push([event, payload]);
        return true;
      }),
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
        { provide: EventEmitter2, useValue: emitter },
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

    it("session.deleted 由 removeWithData 在事务外统一发（不在 removeInDb 内逐个发）", async () => {
      await account.run("acct-1", async () => {
        await service.ensureDefault();
        const target = await service.create(fixture("待删-事件"));
        fakeSessions.findByAgentId.mockResolvedValueOnce([
          { id: "s1" },
          { id: "s2" },
        ]);
        // removeWithMessages 现在返回 agentId、不再自己发事件
        fakeSessions.removeWithMessages
          .mockResolvedValueOnce(target.id)
          .mockResolvedValueOnce(target.id);
        emitted.length = 0;
        await service.removeWithData(target.id);
        const deleted = emitted.filter(
          ([e]) => e === SESSION_LIFECYCLE_EVENTS.deleted,
        );
        expect(
          deleted.map(([, p]) => (p as { sessionId: string }).sessionId),
        ).toEqual(["s1", "s2"]);
        expect(
          deleted.every(
            ([, p]) => (p as { agentId: string }).agentId === target.id,
          ),
        ).toBe(true);
      });
    });

    it("级联删到一半失败 → 一条 session.deleted 都不发（发射必须在事务提交之后）", async () => {
      await account.run("acct-1", async () => {
        await service.ensureDefault();
        const target = await service.create(fixture("删一半炸"));
        fakeSessions.findByAgentId.mockResolvedValueOnce([
          { id: "s1" },
          { id: "s2" },
        ]);
        // s1 删成功、s2 抛错 → removeInDb 在循环中途失败，外层事务回滚。
        // 若发射写在 removeInDb 的循环里（review 指出的缺陷形态），s1 的
        // deleted 已经发出去了：观察者把 s1 移出列表，而数据库回滚后 s1 其实
        // 还在——更糟的是 schedules/checkpointer 是非事务删除、不随回滚恢复，
        // 于是「会话复活但定时任务已丢」。发射挪到事务外才不会出现这个状态。
        fakeSessions.removeWithMessages
          .mockResolvedValueOnce(target.id)
          .mockRejectedValueOnce(new Error("模拟级联删除中途失败"));
        emitted.length = 0;
        await expect(service.removeWithData(target.id)).rejects.toThrow(
          /模拟级联删除中途失败/,
        );
        expect(
          emitted.filter(([e]) => e === SESSION_LIFECYCLE_EVENTS.deleted),
        ).toEqual([]);
      });
    });

    it("只剩一个 Agent 被拒绝时，一条 session.deleted 都不发", async () => {
      await account.run("acct-1", async () => {
        const only = await service.ensureDefault();
        emitted.length = 0;
        await expect(service.removeWithData(only.id)).rejects.toThrow(
          /至少保留一个/,
        );
        expect(
          emitted.filter(([e]) => e === SESSION_LIFECYCLE_EVENTS.deleted),
        ).toEqual([]);
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

    it("并发删除两个不同 Agent（账号只有 2 个）不能都通过检查——必须至少留一个、且有一个请求被拒绝", async () => {
      await account.run("acct-1", async () => {
        const first = await service.ensureDefault();
        const second = await service.create(fixture("第二个"));
        expect(await service.list()).toHaveLength(2);

        const results = await Promise.allSettled([
          service.removeWithData(first.id),
          service.removeWithData(second.id),
        ]);

        const remaining = await service.list();
        expect(remaining.length).toBeGreaterThanOrEqual(1);
        const rejected = results.filter((r) => r.status === "rejected");
        expect(rejected.length).toBeGreaterThanOrEqual(1);
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

  /**
   * 发射点下沉到 Service 的回归护栏。
   *
   * 为什么必须在 Service 层测、而不是只在 Controller 层测：`rename_agent` 工具
   * 改名走 `AGENT_RENAME_PORT` → `AgentService.update()`，**不经过 Controller**。
   * 事件原先在 `AgentController` 里发，于是工具改名后浏览器收不到任何 Agent 列表
   * 失效信号，侧栏 Agent 行与会话标题栏（都吃 `useAgents()` 的 `["agents"]` 缓存）
   * 永远停在旧名字。下面的用例锁住「任何成功写入路径都发一次事件、失败路径不发」。
   */
  describe("AGENT_EVENTS.changed 发射契约", () => {
    it("create 成功发一次，负载带账号与新建 id", async () => {
      await account.run("acct-1", async () => {
        emitter.emit.mockClear();
        const created = await service.create(fixture("新建"));
        expect(emitter.emit).toHaveBeenCalledTimes(1);
        expect(emitter.emit).toHaveBeenCalledWith(AGENT_EVENTS.changed, {
          cloudUserId: "acct-1",
          agentId: created.id,
        });
      });
    });

    it("update 成功发一次 —— 这条正是 rename_agent 工具改名走的路径", async () => {
      await account.run("acct-1", async () => {
        const created = await service.create(fixture("旧名"));
        emitter.emit.mockClear();
        await service.update(created.id, { name: "新名" });
        expect(emitter.emit).toHaveBeenCalledTimes(1);
        expect(emitter.emit).toHaveBeenCalledWith(AGENT_EVENTS.changed, {
          cloudUserId: "acct-1",
          agentId: created.id,
        });
      });
    });

    it("removeWithData 成功发一次，负载带被删 id", async () => {
      await account.run("acct-1", async () => {
        await service.ensureDefault(); // 保证不是最后一个
        const doomed = await service.create(fixture("待删"));
        emitter.emit.mockClear();
        await service.removeWithData(doomed.id);
        expect(emitter.emit).toHaveBeenCalledTimes(1);
        expect(emitter.emit).toHaveBeenCalledWith(AGENT_EVENTS.changed, {
          cloudUserId: "acct-1",
          agentId: doomed.id,
        });
      });
    });

    it("duplicate 只发一次（委托 create，不重复发）", async () => {
      await account.run("acct-1", async () => {
        const src = await service.create(fixture("源"));
        emitter.emit.mockClear();
        const copy = await service.duplicate(src.id);
        expect(emitter.emit).toHaveBeenCalledTimes(1);
        expect(emitter.emit).toHaveBeenCalledWith(AGENT_EVENTS.changed, {
          cloudUserId: "acct-1",
          agentId: copy.id,
        });
      });
    });

    it("删除被拒（只剩一个 Agent）不发事件", async () => {
      await account.run("acct-1", async () => {
        const only = await service.ensureDefault();
        emitter.emit.mockClear();
        await expect(service.removeWithData(only.id)).rejects.toThrow();
        expect(emitter.emit).not.toHaveBeenCalled();
      });
    });

    it("update 目标不存在（404）不发事件", async () => {
      await account.run("acct-1", async () => {
        emitter.emit.mockClear();
        await expect(service.update("ghost", { name: "x" })).rejects.toThrow(
          NotFoundException,
        );
        expect(emitter.emit).not.toHaveBeenCalled();
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
