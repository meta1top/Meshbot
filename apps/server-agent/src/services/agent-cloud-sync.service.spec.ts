import { AccountContextService } from "@meshbot/lib-agent";
import type { Agent } from "../entities/agent.entity";
import { AgentCloudSyncService } from "./agent-cloud-sync.service";

/** 造一条本地 Agent 记录，remoteEnabled 可覆盖（默认 false）。 */
function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    name: "M",
    avatar: "🤖|#f97316",
    description: "desc",
    systemPrompt: "",
    defaultModelConfigId: null,
    remoteEnabled: false,
    visibility: "private",
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    cloudUserId: "u1",
    ...overrides,
  } as Agent;
}

describe("AgentCloudSyncService", () => {
  function build() {
    const account = new AccountContextService();
    const cloud = {
      put: jest.fn().mockResolvedValue(undefined),
    };
    const identity = {
      get: jest.fn(),
      listLoggedIn: jest.fn(),
    };
    const agentService = {
      list: jest.fn(),
    };
    const service = new AgentCloudSyncService(
      cloud as never,
      identity as never,
      account,
      agentService as never,
    );
    return { account, cloud, identity, agentService, service };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("syncNow：只把 remoteEnabled===true 的 Agent 映射后推云端，字段按 AgentSyncInput 形状", async () => {
    const { cloud, identity, agentService, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    agentService.list.mockResolvedValue([
      agentFixture({
        id: "remote-1",
        name: "远程 A",
        avatar: "🤖|#111",
        description: "远程描述",
        visibility: "org",
        remoteEnabled: true,
      }),
      agentFixture({ id: "local-only", remoteEnabled: false }),
    ]);

    const ok = await service.syncNow("u1");

    expect(ok).toBe(true);
    expect(cloud.put).toHaveBeenCalledWith(
      "/api/agent/agents",
      {
        agents: [
          {
            localAgentId: "remote-1",
            name: "远程 A",
            avatar: "🤖|#111",
            description: "远程描述",
            visibility: "org",
          },
        ],
      },
      "mbd_x",
    );
  });

  it("查询成功但 0 个 remote_enabled → 正常推空列表（合法：用户把开关都关了，云端应软删该设备所有远程 agent）", async () => {
    const { cloud, identity, agentService, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    agentService.list.mockResolvedValue([
      agentFixture({ id: "a1", remoteEnabled: false }),
      agentFixture({ id: "a2", remoteEnabled: false }),
    ]);

    const ok = await service.syncNow("u1");

    expect(ok).toBe(true);
    expect(cloud.put).toHaveBeenCalledWith(
      "/api/agent/agents",
      { agents: [] },
      "mbd_x",
    );
  });

  it("agents.list() 抛错 → 绝不推（不能把「查失败」当成 0 个 remote 推空列表，否则会把云端全部软删）", async () => {
    const { cloud, identity, agentService, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    agentService.list.mockRejectedValue(new Error("sqlite busy"));

    const ok = await service.syncNow("u1");

    expect(ok).toBe(false);
    expect(cloud.put).not.toHaveBeenCalled();
  });

  it("agents.list() 在该账号的 account 上下文内执行", async () => {
    const { identity, agentService, service, account } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    let ctxDuringList: string | null = null;
    agentService.list.mockImplementation(async () => {
      ctxDuringList = account.get();
      return [];
    });

    await service.syncNow("u1");

    expect(ctxDuringList).toBe("u1");
  });

  it("identity.get 无 deviceToken → 直接返回 false，不查本地也不推云端", async () => {
    const { cloud, identity, agentService, service } = build();
    identity.get.mockResolvedValue({ deviceToken: null });

    const ok = await service.syncNow("u1");

    expect(ok).toBe(false);
    expect(agentService.list).not.toHaveBeenCalled();
    expect(cloud.put).not.toHaveBeenCalled();
  });

  it("cloud.put 抛错（网络问题）→ syncNow 返回 false 且不 throw", async () => {
    const { cloud, identity, agentService, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    agentService.list.mockResolvedValue([]);
    cloud.put.mockRejectedValue(new Error("network down"));

    await expect(service.syncNow("u1")).resolves.toBe(false);
  });

  describe("事件驱动触发源", () => {
    it("onApplicationBootstrap：对全部已登录账号逐个 syncNow", async () => {
      const { identity, agentService, service } = build();
      identity.listLoggedIn.mockResolvedValue([
        { cloudUserId: "u1" },
        { cloudUserId: "u2" },
      ]);
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      agentService.list.mockResolvedValue([]);

      await service.onApplicationBootstrap();

      expect(identity.get).toHaveBeenCalledWith("u1");
      expect(identity.get).toHaveBeenCalledWith("u2");
    });

    it("AUTH_EVENTS.authorized（登录）→ syncNow 该账号", async () => {
      const { identity, agentService, cloud, service } = build();
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      agentService.list.mockResolvedValue([]);

      await service.onAuthorized({ cloudUserId: "u1" });

      expect(cloud.put).toHaveBeenCalledWith(
        "/api/agent/agents",
        { agents: [] },
        "mbd_x",
      );
    });

    it("IM_RELAY_EVENTS.connected（relay 重连）→ syncNow 该账号", async () => {
      const { identity, agentService, cloud, service } = build();
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      agentService.list.mockResolvedValue([]);

      await service.onRelayConnected({ cloudUserId: "u1" });

      expect(cloud.put).toHaveBeenCalledWith(
        "/api/agent/agents",
        { agents: [] },
        "mbd_x",
      );
    });

    it("AGENT_EVENTS.changed（本地 Agent CRUD）→ syncNow 该账号", async () => {
      const { identity, agentService, cloud, service } = build();
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      agentService.list.mockResolvedValue([]);

      await service.onAgentChanged({ cloudUserId: "u1" });

      expect(cloud.put).toHaveBeenCalledWith(
        "/api/agent/agents",
        { agents: [] },
        "mbd_x",
      );
    });
  });
});
