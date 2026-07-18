import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AccountContextService,
  AgentContextService,
  MeshbotConfigService,
  type McpService,
  type ThreadStateService,
} from "@meshbot/lib-agent";
import { NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { Agent } from "../entities/agent.entity";
import { LlmCall } from "../entities/llm-call.entity";
import { PendingMessage } from "../entities/pending-message.entity";
import { Session } from "../entities/session.entity";
import { SessionMessage } from "../entities/session-message.entity";
import { AgentService } from "../services/agent.service";
import { CheckpointerCleanupService } from "../services/checkpointer-cleanup.service";
import { LlmCallService } from "../services/llm-call.service";
import { SessionMessageService } from "../services/session-message.service";
import { SessionService } from "../services/session.service";
import { AgentController } from "./agent.controller";

/** 造一份最小合法 Agent 创建入参，name 可覆盖。 */
function fixture(name: string) {
  return {
    name,
    avatar: "🤖|#f97316",
    description: "",
    systemPrompt: "你是测试助手",
    defaultModelConfigId: null,
  };
}

const DEFAULT_USER = "test-user";

/**
 * 本文件走「真实 Service + 内存 sqlite」的集成风格（而非 mock AgentService）——
 * DELETE 端点要断言磁盘目录真被清掉、会话真被级联删掉，光靠 mock 验证不了这些
 * 副作用，必须让 AgentService / SessionService / MeshbotConfigService 真跑。
 */
describe("AgentController", () => {
  let prevMeshbotHome: string | undefined;
  let meshbotHome: string;
  let ds: DataSource;
  let account: AccountContextService;
  let agentCtx: AgentContextService;
  let config: MeshbotConfigService;
  let agentService: AgentService;
  let sessionService: SessionService;
  let mcp: { teardownAgent: jest.Mock };
  let emitter: { emit: jest.Mock };
  let controller: AgentController;

  beforeEach(async () => {
    // MeshbotConfigService 在构造时一次性快照 meshbotDir（读 MESHBOT_HOME），
    // 必须在 new 之前把环境变量指到临时目录，测试完毕再还原，避免污染其他用例。
    prevMeshbotHome = process.env.MESHBOT_HOME;
    meshbotHome = mkdtempSync(path.join(tmpdir(), "agent-controller-spec-"));
    process.env.MESHBOT_HOME = meshbotHome;

    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Agent, Session, PendingMessage, LlmCall, SessionMessage],
      synchronize: true,
    });
    await ds.initialize();

    account = new AccountContextService();
    agentCtx = new AgentContextService();
    config = new MeshbotConfigService(account, agentCtx);

    const scopedFactory = new ScopedRepositoryFactory(account);
    const llmCalls = new LlmCallService(
      ds.getRepository(LlmCall),
      scopedFactory,
    );
    const sessionMessages = new SessionMessageService(
      ds.getRepository(SessionMessage),
      scopedFactory,
      account,
    );
    // 假 checkpointer：deleteSession 的级联清理会调它，无需真实 LangGraph 状态。
    const fakeGraph = {
      async cutMessagesAfter() {
        /* 本测试不覆盖 regenerate，无需记录 */
      },
      clearThread() {
        /* 无 checkpoints/writes 表，no-op 即可 */
      },
    };
    const checkpointer = new CheckpointerCleanupService(
      fakeGraph as unknown as ThreadStateService,
    );
    const fakeSchedules = {
      async deleteBySession() {
        /* no-op */
      },
    };
    const fakeModelConfigs = {
      async findOneOrFail(id: string) {
        return { id } as never;
      },
    };
    sessionService = new SessionService(
      ds.getRepository(Session),
      ds.getRepository(PendingMessage),
      scopedFactory,
      llmCalls,
      sessionMessages,
      checkpointer,
      fakeGraph as unknown as ThreadStateService,
      fakeSchedules as unknown as never,
      fakeModelConfigs as unknown as never,
    );
    mcp = { teardownAgent: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };
    agentService = new AgentService(
      ds.getRepository(Agent),
      scopedFactory,
      account,
      config,
      sessionService,
      emitter as unknown as EventEmitter2,
    );
    controller = new AgentController(
      agentService,
      agentCtx,
      config,
      mcp as unknown as McpService,
      account,
    );
  });

  afterEach(async () => {
    await ds.destroy();
    rmSync(meshbotHome, { recursive: true, force: true });
    if (prevMeshbotHome === undefined) {
      delete process.env.MESHBOT_HOME;
    } else {
      process.env.MESHBOT_HOME = prevMeshbotHome;
    }
  });

  /** 所有 controller 调用都跑在 DEFAULT_USER 账号上下文内（模拟鉴权拦截器）。 */
  function run<T>(fn: () => Promise<T>): Promise<T> {
    return account.run(DEFAULT_USER, fn);
  }

  it("list / create / update：基本 CRUD，toAgentView 序列化出 ISO 日期", async () => {
    await run(async () => {
      const created = await controller.create(fixture("新 Agent") as never);
      expect(created.id).toBeTruthy();
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const updated = await controller.update(created.id, {
        name: "改名",
      } as never);
      expect(updated.name).toBe("改名");
      expect(updated.systemPrompt).toBe("你是测试助手");

      const list = await controller.list();
      expect(list.some((a) => a.id === created.id)).toBe(true);
    });
  });

  it("DELETE 会连同磁盘目录一起清掉", async () => {
    await run(async () => {
      await agentService.ensureDefault(); // 保证不是最后一个
      const agent = await controller.create(fixture("待删") as never);
      const dir = config.agentDirOf(agent.id);
      mkdirSync(dir, { recursive: true });
      expect(existsSync(dir)).toBe(true);

      await controller.remove(agent.id);

      expect(existsSync(dir)).toBe(false);
      expect(await agentService.findOrNull(agent.id)).toBeNull();
      expect(mcp.teardownAgent).toHaveBeenCalledWith(DEFAULT_USER, agent.id);
    });
  });

  it("DELETE 会连同该 Agent 的会话一起清掉", async () => {
    await run(async () => {
      await agentService.ensureDefault();
      const agent = await controller.create(fixture("带会话") as never);
      await sessionService.createSession({
        content: "会话",
        agentId: agent.id,
      });
      expect(await sessionService.findByAgentId(agent.id)).toHaveLength(1);

      await controller.remove(agent.id);

      expect(await sessionService.findByAgentId(agent.id)).toHaveLength(0);
    });
  });

  it("DELETE 最后一个 Agent 被拒绝（至少保留一个）", async () => {
    await run(async () => {
      const only = await agentService.ensureDefault();
      await expect(controller.remove(only.id)).rejects.toThrow(/至少保留一个/);
      expect(await agentService.findOrNull(only.id)).not.toBeNull();
    });
  });

  it("duplicate 复制配置但不复制记忆/工作区/会话", async () => {
    await run(async () => {
      const src = await controller.create(fixture("源") as never);
      const copy = await controller.duplicate(src.id);
      expect(copy.name).toBe("源 (副本)");
      expect(copy.systemPrompt).toBe(src.systemPrompt);
      expect(copy.avatar).toBe(src.avatar);
      expect(copy.id).not.toBe(src.id);
      // 副本磁盘目录未被预先创建——记忆/工作区/MCP 配置不复制，从零开始。
      expect(existsSync(config.agentDirOf(copy.id))).toBe(false);
    });
  });

  it("GET mcp：文件不存在时返回默认空配置", async () => {
    await run(async () => {
      const agent = await agentService.ensureDefault();
      const { raw } = await controller.getMcp(agent.id);
      expect(JSON.parse(raw)).toEqual({ mcpServers: {} });
    });
  });

  it("PUT mcp 写入非法 JSON 时抛 400", async () => {
    await run(async () => {
      const agent = await agentService.ensureDefault();
      await expect(
        controller.putMcp(agent.id, { raw: "{ 不是 json" } as never),
      ).rejects.toThrow(/JSON 解析失败/);
    });
  });

  it("PUT mcp 写入 schema 不合法的配置时抛 400", async () => {
    await run(async () => {
      const agent = await agentService.ensureDefault();
      await expect(
        controller.putMcp(agent.id, {
          raw: '{"mcpServers":{"x":{}}}',
        } as never),
      ).rejects.toThrow(/配置校验失败/);
    });
  });

  it("PUT mcp 写入合法配置：落盘 + 失效运行态（teardownAgent）", async () => {
    await run(async () => {
      const agent = await agentService.ensureDefault();
      const validRaw = JSON.stringify({
        mcpServers: { fs: { command: "npx", args: ["-y", "server"] } },
      });
      await controller.putMcp(agent.id, { raw: validRaw } as never);

      const { raw } = await controller.getMcp(agent.id);
      expect(JSON.parse(raw)).toEqual(JSON.parse(validRaw));
      expect(mcp.teardownAgent).toHaveBeenCalledWith(DEFAULT_USER, agent.id);
    });
  });

  it("不存在的 agentId → 404（越权/编造 id 天然查不到）", async () => {
    await run(async () => {
      await expect(controller.getMcp("ghost")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("AGENT_EVENTS.changed：CRUD 成功后触发本地事件（驱动云端推送对账）", () => {
    it("create 成功后 emit agent.changed（携带当前账号）", async () => {
      await run(async () => {
        emitter.emit.mockClear();
        const created = await controller.create(fixture("新 Agent") as never);
        expect(emitter.emit).toHaveBeenCalledWith("agent.changed", {
          cloudUserId: DEFAULT_USER,
          agentId: created.id,
        });
      });
    });

    it("update 成功后 emit agent.changed", async () => {
      await run(async () => {
        const created = await controller.create(fixture("待改") as never);
        emitter.emit.mockClear();
        await controller.update(created.id, { name: "改名" } as never);
        expect(emitter.emit).toHaveBeenCalledWith("agent.changed", {
          cloudUserId: DEFAULT_USER,
          agentId: created.id,
        });
      });
    });

    it("remove 成功后 emit agent.changed", async () => {
      await run(async () => {
        await agentService.ensureDefault(); // 保证不是最后一个
        const agent = await controller.create(fixture("待删") as never);
        emitter.emit.mockClear();
        await controller.remove(agent.id);
        expect(emitter.emit).toHaveBeenCalledWith("agent.changed", {
          cloudUserId: DEFAULT_USER,
          agentId: agent.id,
        });
      });
    });

    it("duplicate 成功后 emit agent.changed", async () => {
      await run(async () => {
        const src = await controller.create(fixture("源") as never);
        emitter.emit.mockClear();
        const copy = await controller.duplicate(src.id);
        expect(emitter.emit).toHaveBeenCalledWith("agent.changed", {
          cloudUserId: DEFAULT_USER,
          agentId: copy.id,
        });
        // duplicate 委托 create()，发射点已下沉到 Service，只应发一次（不重复）
        expect(emitter.emit).toHaveBeenCalledTimes(1);
      });
    });
  });
});
