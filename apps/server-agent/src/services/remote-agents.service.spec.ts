import type { AccountContextService } from "@meshbot/lib-agent";
import type { CloudClientService } from "../cloud/cloud-client.service";
import type { AgentService } from "./agent.service";
import type { CloudIdentityService } from "./cloud-identity.service";
import { RemoteAgentsService } from "./remote-agents.service";

/**
 * 按 path 分派的 fake cloud.get；identity 恒有 device token。
 * `localIds` 为本机 SQLite 里的 Agent id 全集（AgentService.list() 的返回）。
 */
function make(routes: Record<string, unknown>, localIds: string[] = []) {
  const get = jest.fn((path: string) => {
    if (path in routes) return Promise.resolve(routes[path]);
    throw new Error(`unexpected cloud GET ${path}`);
  });
  const cloud = { get } as unknown as CloudClientService;
  const identity = {
    get: jest.fn().mockResolvedValue({ deviceToken: "mbd_tok" }),
  } as unknown as CloudIdentityService;
  const account = { getOrThrow: () => "u1" } as AccountContextService;
  const agents = {
    list: jest.fn().mockResolvedValue(localIds.map((id) => ({ id }))),
  } as unknown as AgentService;
  return {
    svc: new RemoteAgentsService(cloud, identity, account, agents),
    get,
  };
}

/** 造一条设备行（DeviceView 最小形状）。 */
function device(id: string, name: string, isCurrent: boolean) {
  return {
    id,
    name,
    platform: "darwin",
    lastSeenAt: null,
    revokedAt: null,
    createdAt: "",
    isCurrent,
  };
}

describe("RemoteAgentsService.listRemoteAgents", () => {
  it("过滤本机设备的 agent，只留其他设备的远程 Agent，并拼 deviceName/deviceOnline", async () => {
    const { svc } = make(
      {
        "/api/agents": [
          {
            id: "ag-self",
            deviceId: "devA",
            localAgentId: "la1",
            name: "本机",
            avatar: "🛠️|#111",
            description: null,
          },
          {
            id: "ag-remote",
            deviceId: "devB",
            localAgentId: "lb1",
            name: "远程",
            avatar: "🎨|#222",
            description: "设计",
          },
        ],
        "/api/devices": [
          device("devA", "我的 Mac", true),
          device("devB", "工作站", false),
        ],
        "/api/devices/devB/online": { online: true },
      },
      ["la1"],
    );

    const result = await svc.listRemoteAgents();

    expect(result).toEqual([
      {
        id: "ag-remote",
        deviceId: "devB",
        localAgentId: "lb1",
        name: "远程",
        avatar: "🎨|#222",
        description: "设计",
        deviceName: "工作站",
        deviceOnline: true,
      },
    ]);
  });

  it("宿主设备在线探测失败 → deviceOnline 兜底 false，不抛", async () => {
    const { svc } = make({
      "/api/agents": [
        {
          id: "ag-remote",
          deviceId: "devB",
          localAgentId: "lb1",
          name: "远程",
          avatar: "🎨|#222",
          description: null,
        },
      ],
      "/api/devices": [
        device("devA", "本机", true),
        device("devB", "工作站", false),
      ],
      // 故意不给 /api/devices/devB/online → fake get 抛错，服务应吞成 false
    });

    const result = await svc.listRemoteAgents();
    expect(result).toHaveLength(1);
    expect(result[0].deviceOnline).toBe(false);
  });

  it("云端有本机的第二行幽灵 device 时，本机 agent 仍按 localAgentId 被滤掉（deviceId 对不上）", async () => {
    // 同一台机器在云端存在两行 device：旧行 devA-old（幽灵，其上 cloud_agent
    // 永不软删）与当前行 devA-new。deviceId !== currentDeviceId 这一条对
    // 幽灵行完全失效，只有 localAgentId 判据能滤掉它。
    const { svc } = make(
      {
        "/api/agents": [
          {
            id: "ag-ghost",
            deviceId: "devA-old",
            localAgentId: "la1",
            name: "M",
            avatar: "🛠️|#111",
            description: null,
          },
          {
            id: "ag-remote",
            deviceId: "devB",
            localAgentId: "lb1",
            name: "远程",
            avatar: "🎨|#222",
            description: null,
          },
        ],
        "/api/devices": [
          device("devA-new", "我的 Mac", true),
          device("devB", "工作站", false),
        ],
        "/api/devices/devB/online": { online: true },
      },
      ["la1"],
    );

    const result = await svc.listRemoteAgents();

    expect(result.map((a) => a.id)).toEqual(["ag-remote"]);
  });

  it("isCurrent 全 false（currentDeviceId 落 null）时，本机 agent 仍按 localAgentId 被滤掉", async () => {
    const { svc } = make(
      {
        "/api/agents": [
          {
            id: "ag-self",
            deviceId: "devA",
            localAgentId: "la1",
            name: "M",
            avatar: "🛠️|#111",
            description: null,
          },
          {
            id: "ag-remote",
            deviceId: "devB",
            localAgentId: "lb1",
            name: "远程",
            avatar: "🎨|#222",
            description: null,
          },
        ],
        "/api/devices": [
          device("devA", "我的 Mac", false),
          device("devB", "工作站", false),
        ],
        "/api/devices/devA/online": { online: true },
        "/api/devices/devB/online": { online: true },
      },
      ["la1"],
    );

    const result = await svc.listRemoteAgents();

    expect(result.map((a) => a.id)).toEqual(["ag-remote"]);
  });

  it("真远程 agent（localAgentId 不在本地列表）不因本地有其他 Agent 而被误滤", async () => {
    const { svc } = make(
      {
        "/api/agents": [
          {
            id: "ag-remote",
            deviceId: "devB",
            localAgentId: "lb1",
            name: "远程",
            avatar: "🎨|#222",
            description: null,
          },
        ],
        "/api/devices": [
          device("devA", "我的 Mac", true),
          device("devB", "工作站", false),
        ],
        "/api/devices/devB/online": { online: false },
      },
      ["la1", "la2", "la3"],
    );

    const result = await svc.listRemoteAgents();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ag-remote");
    expect(result[0].deviceName).toBe("工作站");
  });
});
