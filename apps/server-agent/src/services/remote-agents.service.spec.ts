import type { AccountContextService } from "@meshbot/lib-agent";
import type { CloudClientService } from "../cloud/cloud-client.service";
import type { CloudIdentityService } from "./cloud-identity.service";
import { RemoteAgentsService } from "./remote-agents.service";

/** 按 path 分派的 fake cloud.get；identity 恒有 device token。 */
function make(routes: Record<string, unknown>) {
  const get = jest.fn((path: string) => {
    if (path in routes) return Promise.resolve(routes[path]);
    throw new Error(`unexpected cloud GET ${path}`);
  });
  const cloud = { get } as unknown as CloudClientService;
  const identity = {
    get: jest.fn().mockResolvedValue({ deviceToken: "mbd_tok" }),
  } as unknown as CloudIdentityService;
  const account = { getOrThrow: () => "u1" } as AccountContextService;
  return { svc: new RemoteAgentsService(cloud, identity, account), get };
}

describe("RemoteAgentsService.listRemoteAgents", () => {
  it("过滤本机设备的 agent，只留其他设备的远程 Agent，并拼 deviceName/deviceOnline", async () => {
    const { svc } = make({
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
        {
          id: "devA",
          name: "我的 Mac",
          platform: "darwin",
          lastSeenAt: null,
          revokedAt: null,
          createdAt: "",
          isCurrent: true,
        },
        {
          id: "devB",
          name: "工作站",
          platform: "linux",
          lastSeenAt: null,
          revokedAt: null,
          createdAt: "",
          isCurrent: false,
        },
      ],
      "/api/devices/devB/online": { online: true },
    });

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
        {
          id: "devA",
          name: "本机",
          platform: "darwin",
          lastSeenAt: null,
          revokedAt: null,
          createdAt: "",
          isCurrent: true,
        },
        {
          id: "devB",
          name: "工作站",
          platform: "linux",
          lastSeenAt: null,
          revokedAt: null,
          createdAt: "",
          isCurrent: false,
        },
      ],
      // 故意不给 /api/devices/devB/online → fake get 抛错，服务应吞成 false
    });

    const result = await svc.listRemoteAgents();
    expect(result).toHaveLength(1);
    expect(result[0].deviceOnline).toBe(false);
  });
});
