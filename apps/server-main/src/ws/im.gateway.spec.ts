import { DevicePresenceService, PresenceService } from "@meshbot/main";
import { IM_WS_EVENTS } from "@meshbot/types";
import { ImGateway } from "./im.gateway";

function makeGateway(overrides: {
  markReadReturn?: Date;
  sockets?: Array<{ data: { user?: { userId?: string } }; emit: jest.Mock }>;
  presence?: {
    setOnline?: jest.Mock;
    setOffline?: jest.Mock;
    heartbeat?: jest.Mock;
    listOnline?: jest.Mock;
    isOnline?: jest.Mock;
  };
  userService?: {
    findById?: jest.Mock;
  };
  jwt?: {
    verify?: jest.Mock;
  };
  devices?: {
    verifyToken?: jest.Mock;
    findById?: jest.Mock;
  };
  agents?: {
    findActiveById?: jest.Mock;
  };
  devicePresence?: {
    setOnline?: jest.Mock;
    setOffline?: jest.Mock;
    heartbeat?: jest.Mock;
    isOnline?: jest.Mock;
    listOnline?: jest.Mock;
  };
}) {
  const conversation = {
    getVisibleOrThrow: jest.fn().mockResolvedValue({ id: "c1" }),
    markRead: jest
      .fn()
      .mockResolvedValue(
        overrides.markReadReturn ?? new Date("2026-06-20T00:00:00Z"),
      ),
  };
  const presence = {
    setOnline:
      overrides.presence?.setOnline ?? jest.fn().mockResolvedValue(undefined),
    setOffline:
      overrides.presence?.setOffline ?? jest.fn().mockResolvedValue(undefined),
    heartbeat:
      overrides.presence?.heartbeat ?? jest.fn().mockResolvedValue(undefined),
    listOnline:
      overrides.presence?.listOnline ?? jest.fn().mockResolvedValue([]),
    // 默认已在线：保持既有测试对「无条件续期」场景的假设不变，
    // FIX B 的「离线不复活」场景在下方单独用 isOnline: false 覆盖。
    isOnline: overrides.presence?.isOnline ?? jest.fn().mockResolvedValue(true),
  };
  const userService = {
    findById:
      overrides.userService?.findById ?? jest.fn().mockResolvedValue(undefined),
  };
  const jwt = {
    verify: overrides.jwt?.verify ?? jest.fn().mockReturnValue({}),
  };
  const devices = {
    verifyToken:
      overrides.devices?.verifyToken ?? jest.fn().mockResolvedValue(undefined),
    findById:
      overrides.devices?.findById ?? jest.fn().mockResolvedValue(undefined),
  };
  const agents = {
    findActiveById:
      overrides.agents?.findActiveById ??
      jest.fn().mockResolvedValue(undefined),
  };
  const devicePresence = {
    setOnline:
      overrides.devicePresence?.setOnline ??
      jest.fn().mockResolvedValue(undefined),
    setOffline:
      overrides.devicePresence?.setOffline ??
      jest.fn().mockResolvedValue(undefined),
    heartbeat:
      overrides.devicePresence?.heartbeat ??
      jest.fn().mockResolvedValue(undefined),
    isOnline:
      overrides.devicePresence?.isOnline ?? jest.fn().mockResolvedValue(true),
    listOnline:
      overrides.devicePresence?.listOnline ?? jest.fn().mockResolvedValue([]),
  };
  const gw = new ImGateway(
    jwt as never,
    conversation as never,
    {} as never, // message
    presence as never, // presence
    userService as never, // userService
    devices as never, // devices
    devicePresence as never, // devicePresence
    agents as never, // agents(CloudAgentService)
  );
  const fetchSockets = jest.fn().mockResolvedValue(overrides.sockets ?? []);
  const roomEmitSpy = jest.fn();
  const toSpy = jest.fn().mockReturnValue({ emit: roomEmitSpy });
  // L3 发起方泛化：user 发起时回流走 server.to(socketId).emit(...)（socket.io
  // 每个 socket 自动加入以自身 id 命名的 room）——真实 Namespace 形状，
  // 不再假造 server.sockets.sockets 二层 Map（那不是本 namespace gateway
  // 运行时 this.server 的真实结构）。device room 与 user 直发共用同一
  // toSpy/roomEmitSpy，断言方式同构：都是 `expect(toSpy).toHaveBeenCalledWith(id)`。
  // `server.emit` 是 `roomEmitSpy` 的别名（同一个 mock 函数对象）：真实代码只
  // 走 `this.server.to(room).emit(...)` 链式调用，从不裸调 `this.server.emit`，
  // 让顶层 `server.emit` 复用同一 mock 既能满足 Task 8 新用例
  // `expect(server.emit).toHaveBeenCalledWith(...)` 的断言风格，又不引入第二条
  // 独立的调用记录（避免两处断言各查各的、漏判）。
  const server = {
    in: jest.fn().mockReturnValue({ fetchSockets }),
    to: toSpy,
    emit: roomEmitSpy,
  };
  (gw as unknown as { server: unknown }).server = server;

  // Task 8：收集 `emitToRequester`（私有方法）投递的 [event, payload] 对，供
  // watch 登记测试直接断言「回给发起方的包」，不必关心它内部走 device room
  // 还是 user socket 直发（两条路径最终都汇入 emitToRequester，探针挂在这一
  // 层最稳，不随内部路由分支变化而碎片化断言）。原实现原样执行，只是多记一笔。
  const emitted: Array<[string, unknown]> = [];
  const gwAny = gw as unknown as {
    emitToRequester: (r: unknown, event: string, payload: unknown) => void;
  };
  const originalEmitToRequester = gwAny.emitToRequester.bind(gw);
  gwAny.emitToRequester = (r: unknown, event: string, payload: unknown) => {
    emitted.push([event, payload]);
    originalEmitToRequester(r, event, payload);
  };

  return {
    gw,
    // Task 8 新用例用 `gateway` 这个名字（与 brief 一致）；`gw` 保留给既有用例，
    // 两者是同一个实例，改哪个都同步生效。
    gateway: gw,
    conversation,
    presence,
    userService,
    jwt,
    devices,
    agents,
    devicePresence,
    toSpy,
    roomEmitSpy,
    server,
    emitted,
  };
}

/** 访问 protected jwtVerify 的测试通道 */
function callJwtVerify(gw: ImGateway, token: string): unknown {
  return (gw as unknown as { jwtVerify(token: string): unknown }).jwtVerify(
    token,
  );
}

describe("ImGateway.handleRead 广播 im.conversation_read", () => {
  it("markRead 后只向该用户的连接广播 conversation_read", async () => {
    const lastReadAt = new Date("2026-06-20T01:02:03Z");
    const mine = { data: { user: { userId: "u1" } }, emit: jest.fn() };
    const other = { data: { user: { userId: "u2" } }, emit: jest.fn() };
    const { gw } = makeGateway({
      markReadReturn: lastReadAt,
      sockets: [mine, other],
    });
    const client = { data: { orgId: "org1", user: { userId: "u1" } } };

    await gw.handleRead({ conversationId: "c1" } as never, client as never);

    expect(mine.emit).toHaveBeenCalledWith(IM_WS_EVENTS.conversationRead, {
      conversationId: "c1",
      lastReadAt: lastReadAt.toISOString(),
    });
    expect(other.emit).not.toHaveBeenCalled();
  });

  it("无 orgId → 不广播", async () => {
    const sock = { data: { user: { userId: "u1" } }, emit: jest.fn() };
    const { gw, conversation } = makeGateway({ sockets: [sock] });
    await gw.handleRead(
      { conversationId: "c1" } as never,
      { data: {} } as never,
    );
    expect(sock.emit).not.toHaveBeenCalled();
    expect(conversation.markRead).not.toHaveBeenCalled();
  });
});

describe("ImGateway.onCloudAgentChanged（Bug #12：云端 Agent 注册表变更实时推送）", () => {
  it("按 org 房间取连接后只向该用户广播 agentRegistryChanged", async () => {
    const mine = { data: { user: { userId: "u1" } }, emit: jest.fn() };
    const other = { data: { user: { userId: "u2" } }, emit: jest.fn() };
    const { gw } = makeGateway({ sockets: [mine, other] });

    await gw.onCloudAgentChanged({ userId: "u1", orgId: "org1" });

    expect(mine.emit).toHaveBeenCalledWith(
      IM_WS_EVENTS.agentRegistryChanged,
      {},
    );
    expect(other.emit).not.toHaveBeenCalled();
  });

  it("orgId 为 null（无组织边缘情况）→ 不查房间、不广播", async () => {
    const sock = { data: { user: { userId: "u1" } }, emit: jest.fn() };
    const { gw } = makeGateway({ sockets: [sock] });

    await gw.onCloudAgentChanged({ userId: "u1", orgId: null });

    expect(sock.emit).not.toHaveBeenCalled();
  });
});

describe("ImGateway.handlePresenceSet（浏览器在线态上报）", () => {
  it("{online:true} → presence.setOnline + 广播 im.presence online:true", async () => {
    const { gw, presence, toSpy, roomEmitSpy } = makeGateway({});
    const client = { data: { orgId: "org1", user: { userId: "u1" } } };

    await gw.handlePresenceSet({ online: true } as never, client as never);

    expect(presence.setOnline).toHaveBeenCalledWith("org1", "u1");
    expect(toSpy).toHaveBeenCalledWith("org:org1");
    expect(roomEmitSpy).toHaveBeenCalledWith(IM_WS_EVENTS.presence, {
      userId: "u1",
      online: true,
    });
  });

  it("{online:false} → presence.setOffline + 广播 im.presence online:false", async () => {
    const { gw, presence, toSpy, roomEmitSpy } = makeGateway({});
    const client = { data: { orgId: "org1", user: { userId: "u1" } } };

    await gw.handlePresenceSet({ online: false } as never, client as never);

    expect(presence.setOffline).toHaveBeenCalledWith("org1", "u1");
    expect(toSpy).toHaveBeenCalledWith("org:org1");
    expect(roomEmitSpy).toHaveBeenCalledWith(IM_WS_EVENTS.presence, {
      userId: "u1",
      online: false,
    });
  });

  it("无 orgId → 不调 setOnline/setOffline，不广播", async () => {
    const { gw, presence, toSpy } = makeGateway({});
    const client = { data: { user: { userId: "u1" } } }; // 无 orgId，userService 返回 undefined

    await gw.handlePresenceSet({ online: true } as never, client as never);

    expect(presence.setOnline).not.toHaveBeenCalled();
    expect(toSpy).not.toHaveBeenCalled();
  });

  it("竞态：无 orgId 但 userService.findById 返回 activeOrgId → 仍 setOnline + 广播", async () => {
    const findById = jest.fn().mockResolvedValue({ activeOrgId: "org1" });
    const { gw, presence, toSpy, roomEmitSpy } = makeGateway({
      userService: { findById },
    });
    const clientData: { user: { userId: string }; orgId?: string } = {
      user: { userId: "u1" },
    }; // 初始无 orgId，模拟竞态
    const client = { data: clientData };

    await gw.handlePresenceSet({ online: true } as never, client as never);

    expect(findById).toHaveBeenCalledWith("u1");
    expect(clientData.orgId).toBe("org1"); // 回写 orgId
    expect(presence.setOnline).toHaveBeenCalledWith("org1", "u1");
    expect(toSpy).toHaveBeenCalledWith("org:org1");
    expect(roomEmitSpy).toHaveBeenCalledWith(IM_WS_EVENTS.presence, {
      userId: "u1",
      online: true,
    });
  });

  it("device 连接（payload 带 deviceId+orgId）竞态兜底 → 直接用 payload.orgId，不查 findById", async () => {
    const findById = jest.fn();
    const { gw, presence } = makeGateway({ userService: { findById } });
    const clientData: {
      user: { userId: string; orgId: string; deviceId: string };
      orgId?: string;
    } = { user: { userId: "u1", orgId: "o-dev", deviceId: "d1" } };
    const client = { data: clientData };

    await gw.handlePresenceSet({ online: true } as never, client as never);

    expect(findById).not.toHaveBeenCalled();
    expect(clientData.orgId).toBe("o-dev");
    expect(presence.setOnline).toHaveBeenCalledWith("o-dev", "u1");
  });
});

describe("ImGateway.jwtVerify（双凭据：用户 JWT + device token）", () => {
  it("mbd_ 前缀 → DeviceService.verifyToken，payload = {userId,orgId,deviceId}", async () => {
    const verifyToken = jest
      .fn()
      .mockResolvedValue({ id: "d1", userId: "u1", orgId: "o1" });
    const { gw, jwt } = makeGateway({ devices: { verifyToken } });

    const payload = await callJwtVerify(gw, "mbd_tok");

    expect(verifyToken).toHaveBeenCalledWith("mbd_tok");
    expect(jwt.verify).not.toHaveBeenCalled();
    expect(payload).toEqual({ userId: "u1", orgId: "o1", deviceId: "d1" });
  });

  it("普通 token → jwt.verify（同步，保持现状）", () => {
    const verify = jest.fn().mockReturnValue({ userId: "u2" });
    const { gw, devices } = makeGateway({ jwt: { verify } });

    const payload = callJwtVerify(gw, "eyJhbGciOi.some.jwt");

    expect(verify).toHaveBeenCalledWith("eyJhbGciOi.some.jwt");
    expect(devices.verifyToken).not.toHaveBeenCalled();
    expect(payload).toEqual({ userId: "u2" }); // 非 Promise，同步返回
  });
});

describe("ImGateway.onAuthedConnect（device 连接 orgId 直接用 payload）", () => {
  function makeClient(user: Record<string, unknown>) {
    const data: Record<string, unknown> = { user };
    return {
      data,
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  it("device 连接 → 不查 findById，入 org 房间用 payload.orgId，同时 join device room + 上线 + 广播 agent presence", async () => {
    const findById = jest.fn();
    const { gw, devicePresence, toSpy, roomEmitSpy } = makeGateway({
      userService: { findById },
    });
    const conversation = {
      listConversations: jest.fn().mockResolvedValue([{ id: "c1" }]),
    };
    (gw as unknown as { conversation: unknown }).conversation = conversation;
    const client = makeClient({ userId: "u1", orgId: "o-dev", deviceId: "d1" });

    await (
      gw as unknown as { onAuthedConnect(c: unknown): Promise<void> }
    ).onAuthedConnect(client);

    expect(findById).not.toHaveBeenCalled();
    expect(client.data.orgId).toBe("o-dev");
    expect(client.join).toHaveBeenCalledWith("org:o-dev");
    expect(client.join).toHaveBeenCalledWith("device:d1");
    expect(devicePresence.setOnline).toHaveBeenCalledWith("o-dev", "d1");
    expect(toSpy).toHaveBeenCalledWith("org:o-dev");
    expect(roomEmitSpy).toHaveBeenCalledWith("im.presence", {
      userId: "device:d1",
      online: true,
    });
    expect(conversation.listConversations).toHaveBeenCalledWith("u1", "o-dev");
    // Agent-DM 会话 conv room 同样靠 listConversations(device.userId,...) 覆盖
    expect(client.join).toHaveBeenCalledWith("conv:c1");
  });

  it("用户 JWT 连接 → 保持现状查 activeOrgId", async () => {
    const findById = jest.fn().mockResolvedValue({ activeOrgId: "o-user" });
    const { gw } = makeGateway({ userService: { findById } });
    const conversation = {
      listConversations: jest.fn().mockResolvedValue([]),
    };
    (gw as unknown as { conversation: unknown }).conversation = conversation;
    const client = makeClient({ userId: "u1", orgId: "o-stale" });

    await (
      gw as unknown as { onAuthedConnect(c: unknown): Promise<void> }
    ).onAuthedConnect(client);

    expect(findById).toHaveBeenCalledWith("u1");
    expect(client.data.orgId).toBe("o-user");
    expect(client.join).toHaveBeenCalledWith("org:o-user");
  });

  it("回放设备级在线快照：把 devicePresence.listOnline 的设备以 agent:<id> 下发给本连接", async () => {
    const listOnline = jest.fn().mockResolvedValue(["dX", "dY"]);
    const { gw } = makeGateway({ devicePresence: { listOnline } });
    const conversation = {
      listConversations: jest.fn().mockResolvedValue([]),
    };
    (gw as unknown as { conversation: unknown }).conversation = conversation;
    const client = makeClient({ userId: "u1", orgId: "o1", deviceId: "dA" });

    await (
      gw as unknown as { onAuthedConnect(c: unknown): Promise<void> }
    ).onAuthedConnect(client);

    expect(listOnline).toHaveBeenCalledWith("o1");
    expect(client.emit).toHaveBeenCalledWith("im.presence", {
      userId: "device:dX",
      online: true,
    });
    expect(client.emit).toHaveBeenCalledWith("im.presence", {
      userId: "device:dY",
      online: true,
    });
  });
});

describe("ImGateway.handleDisconnect（device 连接下线）", () => {
  it("device 连接断连 → devicePresence.setOffline + 广播 agent presence offline（旁路，user setOffline 仍执行）", async () => {
    const { gw, presence, devicePresence, toSpy, roomEmitSpy } = makeGateway(
      {},
    );
    const client = {
      data: {
        orgId: "o-dev",
        user: { userId: "u1", orgId: "o-dev", deviceId: "d1" },
      },
    };

    await gw.handleDisconnect(client as never);

    expect(devicePresence.setOffline).toHaveBeenCalledWith("o-dev", "d1");
    expect(presence.setOffline).toHaveBeenCalledWith("o-dev", "u1");
    expect(toSpy).toHaveBeenCalledWith("org:o-dev");
    expect(roomEmitSpy).toHaveBeenCalledWith("im.presence", {
      userId: "device:d1",
      online: false,
    });
    expect(roomEmitSpy).toHaveBeenCalledWith("im.presence", {
      userId: "u1",
      online: false,
    });
  });

  it("用户 JWT 连接断连 → 不调 devicePresence.setOffline", async () => {
    const { gw, presence, devicePresence } = makeGateway({});
    const client = { data: { orgId: "o1", user: { userId: "u1" } } };

    await gw.handleDisconnect(client as never);

    expect(devicePresence.setOffline).not.toHaveBeenCalled();
    expect(presence.setOffline).toHaveBeenCalledWith("o1", "u1");
  });

  it("L3:target(dB)掉线 → 清理其参与的 agent.run 路由(之后 control 该 streamId 被拒)", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    await registerRoute(gw, toSpy, roomEmitSpy);

    await gw.handleDisconnect({
      data: { orgId: "oB", user: { userId: "u1", deviceId: "dB" } },
    } as never);

    toSpy.mockClear();
    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      {
        data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
      } as never,
    );
    expect(toSpy).not.toHaveBeenCalled();
  });

  it("L3:requester(dA)掉线 → 清理其参与的 agent.run 路由(之后 control 该 streamId 被拒)", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    await registerRoute(gw, toSpy, roomEmitSpy);

    await gw.handleDisconnect({
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    } as never);

    toSpy.mockClear();
    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      {
        data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
      } as never,
    );
    expect(toSpy).not.toHaveBeenCalled();
  });
});

describe("ImGateway.handlePing（心跳续期 presence TTL）", () => {
  it("FIX1：device 连接（payload 带 deviceId）→ devicePresence.heartbeat + presence.heartbeat 都续期（用户级已在线）", async () => {
    const { gw, presence, devicePresence } = makeGateway({});
    const client = {
      data: {
        orgId: "o-dev",
        user: { userId: "u1", orgId: "o-dev", deviceId: "d1" },
      },
    };

    await gw.handlePing(client as never);

    expect(devicePresence.heartbeat).toHaveBeenCalledWith("o-dev", "d1");
    expect(presence.isOnline).toHaveBeenCalledWith("o-dev", "u1");
    expect(presence.heartbeat).toHaveBeenCalledWith("o-dev", "u1");
  });

  it("用户 JWT 连接（无 deviceId）→ 只续期用户级，不碰 devicePresence.heartbeat", async () => {
    const { gw, presence, devicePresence } = makeGateway({});
    const client = { data: { orgId: "o1", user: { userId: "u1" } } };

    await gw.handlePing(client as never);

    expect(devicePresence.heartbeat).not.toHaveBeenCalled();
    expect(presence.heartbeat).toHaveBeenCalledWith("o1", "u1");
  });

  it("无 orgId → 不续期任何一级", async () => {
    const { gw, presence, devicePresence } = makeGateway({});
    const client = { data: { user: { userId: "u1", deviceId: "d1" } } };

    await gw.handlePing(client as never);

    expect(devicePresence.heartbeat).not.toHaveBeenCalled();
    expect(presence.heartbeat).not.toHaveBeenCalled();
  });

  it("终审复核 FIX B：用户级已离线（浏览器关闭 setOffline 之后）→ 即便 device ping 持续发，也不会重新续期用户级；设备级仍无条件续期", async () => {
    const isOnline = jest.fn().mockResolvedValue(false);
    const { gw, presence, devicePresence } = makeGateway({
      presence: { isOnline },
    });
    const client = {
      data: {
        orgId: "o-dev",
        user: { userId: "u1", orgId: "o-dev", deviceId: "d1" },
      },
    };

    await gw.handlePing(client as never);

    expect(devicePresence.heartbeat).toHaveBeenCalledWith("o-dev", "d1");
    expect(presence.isOnline).toHaveBeenCalledWith("o-dev", "u1");
    expect(presence.heartbeat).not.toHaveBeenCalled();
  });
});

describe("终审复核 FIX B（集成：真实 PresenceService + DevicePresenceService，不 mock）", () => {
  it("浏览器关闭（presence_set online:false）后，即便设备 ping 持续发（跨越用户级 TTL 窗口），用户级 presence 仍离线；设备级因 ping 持续续期保持在线", async () => {
    let now = 1_000_000;
    // 真实服务 + 可控假时钟：redis=null 走内存回退路径，语义与生产 Redis 路径一致。
    const presence = new PresenceService(null, () => now);
    const devicePresence = new DevicePresenceService(null, () => now);
    const gw = new ImGateway(
      {} as never, // jwt
      {} as never, // conversation
      {} as never, // message
      presence,
      {} as never, // userService
      {} as never, // devices
      devicePresence,
      {} as never, // agents(CloudAgentService)
    );
    (gw as unknown as { server: unknown }).server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    };
    const client = {
      data: {
        orgId: "org1",
        user: { userId: "u1", orgId: "org1", deviceId: "d1" },
      },
    };

    // 初始：浏览器在看 → 用户上线；设备连着 server-main → 设备上线
    // （分别对应 handlePresenceSet({online:true}) 与 onAuthedConnect 的效果）。
    await presence.setOnline("org1", "u1");
    await devicePresence.setOnline("org1", "d1");
    expect(await presence.listOnline("org1")).toContain("u1");

    // 浏览器关闭：EventsGateway 聚合浏览器连接数 0 → relay.setUiPresence(false)
    // → 上报 im.presence_set {online:false}，用户级立即下线。
    await gw.handlePresenceSet({ online: false } as never, client as never);
    expect(await presence.listOnline("org1")).not.toContain("u1");

    // 设备仍连着 server-main（headless），relay 每 20s 无条件发一次 im.ping；
    // 推进 3 轮（60s，超过用户级 TTL 45s 一整个窗口）。
    for (let i = 0; i < 3; i++) {
      now += 20_000;
      await gw.handlePing(client as never);
    }

    // 验收：用户级 presence 没被 ping 复活（跨越 TTL 窗口后仍离线）；
    // 设备级 presence 因持续 ping 续期，未过期，仍在线。
    expect(await presence.listOnline("org1")).not.toContain("u1");
    expect(await devicePresence.listOnline("org1")).toContain("d1");
  });
});

describe("ImGateway.handleDeviceQueryRequest(L2c 路由 + 门控)", () => {
  it("同账号 + 在线 → 定向下发到 device:target(附 requesterDeviceId + localAgentId)", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };
    await gw.handleDeviceQueryRequest(
      {
        correlationId: "c1",
        targetAgentId: "agentB",
        kind: "sessions",
        params: {},
      } as never,
      client as never,
    );
    expect(findActiveById).toHaveBeenCalledWith("agentB");
    expect(isOnline).toHaveBeenCalledWith("oB", "dB");
    expect(toSpy).toHaveBeenCalledWith("device:dB");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.request", {
      correlationId: "c1",
      targetAgentId: "agentB",
      kind: "sessions",
      params: {},
      requesterDeviceId: "dA",
      localAgentId: "la1",
    });
  });

  it("跨账号 → 回 ok:false cross_account 给 requester,不下发", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u2",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
    });
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };
    await gw.handleDeviceQueryRequest(
      {
        correlationId: "c1",
        targetAgentId: "agentB",
        kind: "sessions",
        params: {},
      } as never,
      client as never,
    );
    expect(toSpy).toHaveBeenCalledWith("device:dA");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", {
      correlationId: "c1",
      requesterDeviceId: "dA",
      ok: false,
      reason: "cross_account",
    });
    expect(toSpy).not.toHaveBeenCalledWith("device:dB");
  });

  it("目标 Agent 不存在(未注册/已软删) → 回 ok:false cross_account 给 requester,不下发", async () => {
    const findActiveById = jest.fn().mockResolvedValue(null);
    const { gw, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
    });
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };
    await gw.handleDeviceQueryRequest(
      {
        correlationId: "c1",
        targetAgentId: "agent-gone",
        kind: "sessions",
        params: {},
      } as never,
      client as never,
    );
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", {
      correlationId: "c1",
      requesterDeviceId: "dA",
      ok: false,
      reason: "cross_account",
    });
  });

  it("离线 → 回 ok:false offline", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(false);
    const { gw, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };
    await gw.handleDeviceQueryRequest(
      {
        correlationId: "c1",
        targetAgentId: "agentB",
        kind: "sessions",
        params: {},
      } as never,
      client as never,
    );
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", {
      correlationId: "c1",
      requesterDeviceId: "dA",
      ok: false,
      reason: "offline",
    });
  });

  it("L3 发起方泛化：user 连接(无 deviceId)发起 → 同账号+在线仍下发到 target，requesterDeviceId 为 user:<sid>", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const client = {
      id: "sockA",
      data: { orgId: "oA", user: { userId: "u1" } },
    };
    await gw.handleDeviceQueryRequest(
      {
        correlationId: "c1",
        targetAgentId: "agentB",
        kind: "sessions",
        params: {},
      } as never,
      client as never,
    );
    expect(isOnline).toHaveBeenCalledWith("oB", "dB");
    expect(toSpy).toHaveBeenCalledWith("device:dB");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.request", {
      correlationId: "c1",
      targetAgentId: "agentB",
      kind: "sessions",
      params: {},
      requesterDeviceId: "user:sockA",
      localAgentId: "la1",
    });
  });

  it("L3 发起方泛化：user 连接跨账号 → 回 ok:false cross_account 直发该 socket（非 device room）", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u2",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
    });
    const client = {
      id: "sockA",
      data: { orgId: "oA", user: { userId: "u1" } },
    };
    await gw.handleDeviceQueryRequest(
      {
        correlationId: "c1",
        targetAgentId: "agentB",
        kind: "sessions",
        params: {},
      } as never,
      client as never,
    );
    expect(toSpy).toHaveBeenCalledWith("sockA");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", {
      correlationId: "c1",
      requesterDeviceId: "user:sockA",
      ok: false,
      reason: "cross_account",
    });
    expect(toSpy).not.toHaveBeenCalledWith("device:dB");
  });
});

/**
 * 用 handleDeviceQueryRequest 登记一条 c1 路由(requester=dA, target=agentB/dB)。
 * deviceQueryResponse 现在必须先有登记的 correlationId 路由才会被放行
 * （安全修复：不再信任 body.requesterDeviceId，改为发送方 = 登记的
 * targetDeviceId 校验；登记时按 targetAgentId 查 CloudAgentService 解出）。
 */
async function registerQueryRoute(
  gw: ImGateway,
  toSpy: jest.Mock,
  roomEmitSpy: jest.Mock,
  agents: { findActiveById: jest.Mock },
  devicePresence: { isOnline: jest.Mock },
): Promise<void> {
  agents.findActiveById.mockResolvedValue({
    id: "agentB",
    userId: "u1",
    orgId: "oB",
    deviceId: "dB",
    localAgentId: "la1",
  });
  devicePresence.isOnline.mockResolvedValue(true);
  const client = {
    data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
  };
  await gw.handleDeviceQueryRequest(
    {
      correlationId: "c1",
      targetAgentId: "agentB",
      kind: "sessions",
      params: {},
    } as never,
    client as never,
  );
  toSpy.mockClear();
  roomEmitSpy.mockClear();
}

describe("ImGateway.handleDeviceQueryResponse(L2c 回流路由 + 发送方校验)", () => {
  it("发送方=登记 target 的宿主设备(dB) → 定向回登记的 requester(device:dA)，用后即删路由", async () => {
    const findActiveById = jest.fn();
    const isOnline = jest.fn();
    const { gw, toSpy, roomEmitSpy, agents, devicePresence } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    await registerQueryRoute(gw, toSpy, roomEmitSpy, agents, devicePresence);

    const body = {
      correlationId: "c1",
      requesterDeviceId: "dA",
      ok: true,
      data: [],
    };
    await gw.handleDeviceQueryResponse(
      body as never,
      { data: { user: { deviceId: "dB" } } } as never,
    );
    expect(toSpy).toHaveBeenCalledWith("device:dA");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", body);

    // 用后即删：同 correlationId 第二次响应被丢弃
    toSpy.mockClear();
    roomEmitSpy.mockClear();
    await gw.handleDeviceQueryResponse(
      body as never,
      { data: { user: { deviceId: "dB" } } } as never,
    );
    expect(toSpy).not.toHaveBeenCalled();
  });

  it("L3 发起方泛化：requester 为 user 连接 → 定向回登记的 socketId 直发，不走 device room", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const requesterClient = {
      id: "sockA",
      data: { orgId: "oA", user: { userId: "u1" } },
    };
    await gw.handleDeviceQueryRequest(
      {
        correlationId: "c1",
        targetAgentId: "agentB",
        kind: "sessions",
        params: {},
      } as never,
      requesterClient as never,
    );
    toSpy.mockClear();
    roomEmitSpy.mockClear();

    const body = {
      correlationId: "c1",
      requesterDeviceId: "user:sockA",
      ok: true,
      data: [],
    };
    await gw.handleDeviceQueryResponse(
      body as never,
      { data: { user: { deviceId: "dB" } } } as never,
    );
    expect(toSpy).toHaveBeenCalledWith("sockA");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", body);
  });

  it("安全修复：伪造 response（无登记 correlationId）→ 静默丢弃", async () => {
    const { gw, toSpy } = makeGateway({});
    const body = {
      correlationId: "never-registered",
      requesterDeviceId: "user:victim-socket",
      ok: true,
      data: [],
    };
    await gw.handleDeviceQueryResponse(
      body as never,
      { data: { user: { deviceId: "dC" } } } as never,
    );
    expect(toSpy).not.toHaveBeenCalled();
  });

  it("安全修复：非登记目标设备回流（伪造发送方）→ 静默丢弃，路由不删（合法目标仍可正常回)", async () => {
    const findActiveById = jest.fn();
    const isOnline = jest.fn();
    const { gw, toSpy, roomEmitSpy, agents, devicePresence } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    await registerQueryRoute(gw, toSpy, roomEmitSpy, agents, devicePresence);

    // 攻击者 dC 伪造响应,企图借 body.requesterDeviceId 冒充 dA 的登记路由回流
    await gw.handleDeviceQueryResponse(
      {
        correlationId: "c1",
        requesterDeviceId: "dA",
        ok: true,
        data: ["leaked"],
      } as never,
      { data: { user: { deviceId: "dC" } } } as never,
    );
    expect(toSpy).not.toHaveBeenCalled();

    // 路由未被清空：合法目标(dB)仍能正常回流
    const body = {
      correlationId: "c1",
      requesterDeviceId: "dA",
      ok: true,
      data: [],
    };
    await gw.handleDeviceQueryResponse(
      body as never,
      { data: { user: { deviceId: "dB" } } } as never,
    );
    expect(toSpy).toHaveBeenCalledWith("device:dA");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", body);
  });
});

describe("ImGateway.handleAgentRunStart(L3 Phase A 路由 + streamId 登记)", () => {
  it("同账号 + 在线 → 登记 streamId 路由 + 定向下发 device:target(附 requesterDeviceId + localAgentId)", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };

    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        mode: "create",
        content: "hi",
      } as never,
      client as never,
    );

    expect(findActiveById).toHaveBeenCalledWith("agentB");
    expect(isOnline).toHaveBeenCalledWith("oB", "dB");
    expect(toSpy).toHaveBeenCalledWith("device:dB");
    expect(roomEmitSpy).toHaveBeenCalledWith("agent.run.start", {
      streamId: "s1",
      targetAgentId: "agentB",
      mode: "create",
      content: "hi",
      requesterDeviceId: "dA",
      localAgentId: "la1",
    });

    // streamId 路由已登记：后续 control 帧发起方=dA 应被放行、定向到 dB
    const controlToSpy = toSpy;
    controlToSpy.mockClear();
    roomEmitSpy.mockClear();
    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      client as never,
    );
    expect(controlToSpy).toHaveBeenCalledWith("device:dB");
  });

  it("跨账号 → 不下发、不登记路由", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u2",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const { gw, toSpy } = makeGateway({ agents: { findActiveById } });
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };

    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        mode: "create",
        content: "hi",
      } as never,
      client as never,
    );

    expect(toSpy).not.toHaveBeenCalled();
  });

  it("目标 Agent 不存在(未注册/已软删) → 不下发、不登记路由", async () => {
    const findActiveById = jest.fn().mockResolvedValue(null);
    const { gw, toSpy } = makeGateway({ agents: { findActiveById } });
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };

    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agent-gone",
        mode: "create",
        content: "hi",
      } as never,
      client as never,
    );

    expect(toSpy).not.toHaveBeenCalled();
  });

  it("离线 → 回 agentRunEnd{reason:offline} 给 requester,不登记路由", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(false);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };

    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        mode: "create",
        content: "hi",
      } as never,
      client as never,
    );

    expect(toSpy).toHaveBeenCalledWith("device:dA");
    expect(roomEmitSpy).toHaveBeenCalledWith("agent.run.end", {
      streamId: "s1",
      requesterDeviceId: "dA",
      reason: "offline",
    });
    expect(toSpy).not.toHaveBeenCalledWith("device:dB");
  });

  it("L3 发起方泛化：user 连接(无 deviceId)发起 → 同账号+在线仍登记路由 + 下发，requesterDeviceId 为 user:<sid>；登记的 streamId 可被同一 user socket 发起的 control 转发", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const client = {
      id: "sockA",
      data: { orgId: "oA", user: { userId: "u1" } },
    };

    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        mode: "create",
        content: "hi",
      } as never,
      client as never,
    );

    expect(findActiveById).toHaveBeenCalledWith("agentB");
    expect(isOnline).toHaveBeenCalledWith("oB", "dB");
    expect(toSpy).toHaveBeenCalledWith("device:dB");
    expect(roomEmitSpy).toHaveBeenCalledWith("agent.run.start", {
      streamId: "s1",
      targetAgentId: "agentB",
      mode: "create",
      content: "hi",
      requesterDeviceId: "user:sockA",
      localAgentId: "la1",
    });

    // streamId 路由已登记 kind:"user"：同一 socket 发起的 control 帧应被放行、定向到 dB
    toSpy.mockClear();
    roomEmitSpy.mockClear();
    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      client as never,
    );
    expect(toSpy).toHaveBeenCalledWith("device:dB");
    expect(roomEmitSpy).toHaveBeenCalledWith("agent.run.control", {
      streamId: "s1",
      targetAgentId: "agentB",
      sessionId: "sess1",
      kind: "interrupt",
      requesterDeviceId: "user:sockA",
      localAgentId: "la1",
    });
  });

  it("L3 发起方泛化：不同 user socket（他人）对同一 streamId 发 control → 越权拒，不下发", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const ownerClient = {
      id: "sockA",
      data: { orgId: "oA", user: { userId: "u1" } },
    };
    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        mode: "create",
        content: "hi",
      } as never,
      ownerClient as never,
    );
    toSpy.mockClear();

    const otherClient = {
      id: "sockX",
      data: { orgId: "oA", user: { userId: "u1" } },
    };
    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      otherClient as never,
    );

    expect(toSpy).not.toHaveBeenCalled();
  });

  it("L3 发起方泛化：B 侧运行帧回流 → user 发起方按 socketId 直发（不走 device room）", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const client = {
      id: "sockA",
      data: { orgId: "oA", user: { userId: "u1" } },
    };
    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        mode: "create",
        content: "hi",
      } as never,
      client as never,
    );
    toSpy.mockClear();
    roomEmitSpy.mockClear();

    const body = {
      streamId: "s1",
      requesterDeviceId: "user:sockA",
      seq: 1,
      sessionId: "sess1",
      event: "session.token",
      payload: { text: "x" },
    };
    await gw.handleAgentRunFrame(
      body as never,
      { data: { user: { deviceId: "dB" } } } as never,
    );

    expect(toSpy).toHaveBeenCalledWith("sockA");
    expect(roomEmitSpy).toHaveBeenCalledWith("agent.run.frame", body);
    expect(toSpy).not.toHaveBeenCalledWith("device:dB");
  });

  it("L3 发起方泛化：user socket 断连 → 其发起的路由被清理（之后 control 该 streamId 被拒）", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const client = {
      id: "sockA",
      data: { orgId: "oA", user: { userId: "u1" } },
    };
    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        mode: "create",
        content: "hi",
      } as never,
      client as never,
    );
    toSpy.mockClear();

    await gw.handleDisconnect({
      id: "sockA",
      data: { orgId: "oA", user: { userId: "u1" } },
    } as never);
    toSpy.mockClear(); // handleDisconnect 自身会广播 presence offline，与路由清理断言无关，先清空

    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      client as never,
    );
    expect(toSpy).not.toHaveBeenCalled();
  });
});

/** 用 handleAgentRunStart 登记一条 s1 路由(requester=dA, target=agentB/dB)。 */
async function registerRoute(
  gw: ImGateway,
  toSpy: jest.Mock,
  roomEmitSpy: jest.Mock,
): Promise<void> {
  const client = {
    data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
  };
  await gw.handleAgentRunStart(
    {
      streamId: "s1",
      targetAgentId: "agentB",
      mode: "create",
      content: "hi",
    } as never,
    client as never,
  );
  toSpy.mockClear();
  roomEmitSpy.mockClear();
}

describe("ImGateway.handleAgentRunFrame(L3 Phase A 回流路由 + 发送方校验)", () => {
  function makeGwWithRoute() {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    return makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
  }

  it("发送方=登记 target 的宿主设备(dB) → 定向回登记的 requester(device:dA)", async () => {
    const { gw, toSpy, roomEmitSpy } = makeGwWithRoute();
    await registerRoute(gw, toSpy, roomEmitSpy);
    const body = {
      streamId: "s1",
      requesterDeviceId: "dA",
      seq: 1,
      sessionId: "sess1",
      event: "session.token",
      payload: { text: "x" },
    };

    await gw.handleAgentRunFrame(
      body as never,
      { data: { user: { deviceId: "dB" } } } as never,
    );

    expect(toSpy).toHaveBeenCalledWith("device:dA");
    expect(roomEmitSpy).toHaveBeenCalledWith("agent.run.frame", body);
  });

  it("发送方≠登记 target(伪造 requesterDeviceId 冒充 B) → 不下发", async () => {
    const { gw, toSpy, roomEmitSpy } = makeGwWithRoute();
    await registerRoute(gw, toSpy, roomEmitSpy);
    // 攻击者 dC 伪造一帧,body.requesterDeviceId 指向受害者 dV,企图注入其房间
    await gw.handleAgentRunFrame(
      {
        streamId: "s1",
        requesterDeviceId: "dV",
        seq: 1,
        sessionId: "sess1",
        event: "session.token",
        payload: { text: "x" },
      } as never,
      { data: { user: { deviceId: "dC" } } } as never,
    );

    expect(toSpy).not.toHaveBeenCalled();
  });

  it("未知 streamId → 不下发", async () => {
    const { gw, toSpy } = makeGwWithRoute();
    await gw.handleAgentRunFrame(
      {
        streamId: "unknown",
        requesterDeviceId: "dA",
        seq: 1,
        sessionId: "sess1",
        event: "session.token",
        payload: {},
      } as never,
      { data: { user: { deviceId: "dB" } } } as never,
    );

    expect(toSpy).not.toHaveBeenCalled();
  });
});

describe("ImGateway.handleAgentRunEnd(L3 Phase A 回流路由 + 发送方校验 + 路由清理)", () => {
  function makeGwWithRoute() {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    return makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
  }

  it("发送方=登记 target 的宿主设备(dB) → 定向回 device:dA,并删除 streamId 路由", async () => {
    const { gw, toSpy, roomEmitSpy } = makeGwWithRoute();
    await registerRoute(gw, toSpy, roomEmitSpy);

    const body = { streamId: "s1", requesterDeviceId: "dA", reason: "done" };
    await gw.handleAgentRunEnd(
      body as never,
      { data: { user: { deviceId: "dB" } } } as never,
    );

    expect(toSpy).toHaveBeenCalledWith("device:dA");
    expect(roomEmitSpy).toHaveBeenCalledWith("agent.run.end", body);

    // 路由已删除：requester(dA)再发 control 应被拒(越权/未知)
    toSpy.mockClear();
    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      {
        data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
      } as never,
    );
    expect(toSpy).not.toHaveBeenCalled();
  });

  it("发送方≠登记 target(伪造 end 提前终止) → 不下发、不删路由", async () => {
    const { gw, toSpy, roomEmitSpy } = makeGwWithRoute();
    await registerRoute(gw, toSpy, roomEmitSpy);

    await gw.handleAgentRunEnd(
      { streamId: "s1", requesterDeviceId: "dA", reason: "done" } as never,
      { data: { user: { deviceId: "dC" } } } as never,
    );

    expect(toSpy).not.toHaveBeenCalled();

    // 路由未被清空：合法 requester(dA)仍能发 control → 正常下发到 dB
    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      {
        data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
      } as never,
    );
    expect(toSpy).toHaveBeenCalledWith("device:dB");
  });
});

describe("ImGateway.handleAgentRunControl(L3 Phase A 控制帧路由 + 越权拒)", () => {
  it("已登记 streamId,发起方=登记 requester → 定向下发到目标设备(附 requesterDeviceId + localAgentId)", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };
    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        mode: "create",
        content: "hi",
      } as never,
      client as never,
    );
    toSpy.mockClear();
    roomEmitSpy.mockClear();

    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "confirm",
        toolCallId: "tc1",
        decision: "send",
      } as never,
      client as never,
    );

    expect(toSpy).toHaveBeenCalledWith("device:dB");
    expect(roomEmitSpy).toHaveBeenCalledWith("agent.run.control", {
      streamId: "s1",
      targetAgentId: "agentB",
      sessionId: "sess1",
      kind: "confirm",
      toolCallId: "tc1",
      decision: "send",
      requesterDeviceId: "dA",
      localAgentId: "la1",
    });
  });

  it("发起方≠登记 requester → 越权拒,不下发", async () => {
    const findActiveById = jest.fn().mockResolvedValue({
      id: "agentB",
      userId: "u1",
      orgId: "oB",
      deviceId: "dB",
      localAgentId: "la1",
    });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy } = makeGateway({
      agents: { findActiveById },
      devicePresence: { isOnline },
    });
    const requesterClient = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };
    await gw.handleAgentRunStart(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        mode: "create",
        content: "hi",
      } as never,
      requesterClient as never,
    );
    toSpy.mockClear();

    const attackerClient = {
      data: { orgId: "oC", user: { userId: "u3", deviceId: "dC" } },
    };
    await gw.handleAgentRunControl(
      {
        streamId: "s1",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      attackerClient as never,
    );

    expect(toSpy).not.toHaveBeenCalled();
  });

  it("未知 streamId → 不下发", async () => {
    const { gw, toSpy } = makeGateway({});
    const client = {
      data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } },
    };

    await gw.handleAgentRunControl(
      {
        streamId: "unknown",
        targetAgentId: "agentB",
        sessionId: "sess1",
        kind: "interrupt",
      } as never,
      client as never,
    );

    expect(toSpy).not.toHaveBeenCalled();
  });
});

describe("Agent 级观察通道：watch 登记", () => {
  const client = (over: Record<string, unknown> = {}) =>
    ({
      id: "sock-1",
      data: { user: { userId: "u1" }, orgId: "org-1" },
      ...over,
    }) as never;

  it("跨账号 watch 被拒（不下发设备、不登记）", async () => {
    const { gateway, server } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1",
          userId: "别人",
          orgId: "org-1",
          deviceId: "dev-b",
          localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "agent" },
      client(),
    );
    expect(server.to).not.toHaveBeenCalledWith("device:dev-b");
    expect(gateway.watchRouteCount()).toBe(0);
  });

  it("设备离线 → 回 accepted{ok:false,reason:'offline'}，不登记（不静默）", async () => {
    const { gateway, emitted } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1",
          userId: "u1",
          orgId: "org-1",
          deviceId: "dev-b",
          localAgentId: "local-a1",
        }),
      },
      devicePresence: { isOnline: jest.fn().mockResolvedValue(false) },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "agent" },
      client(),
    );
    expect(emitted).toContainEqual([
      IM_WS_EVENTS.agentWatchAccepted,
      { watchId: "w1", ok: false, reason: "offline" },
    ]);
    expect(gateway.watchRouteCount()).toBe(0);
  });

  it("agent scope 合法 → 登记 watchRoutes + agentWatchers 并转发设备", async () => {
    const { gateway, server } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1",
          userId: "u1",
          orgId: "org-1",
          deviceId: "dev-b",
          localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "agent" },
      client(),
    );
    expect(gateway.watchRouteCount()).toBe(1);
    expect(gateway.agentWatcherIds("dev-b", "local-a1")).toEqual(["w1"]);
    expect(server.to).toHaveBeenCalledWith("device:dev-b");
    expect(server.emit).toHaveBeenCalledWith(IM_WS_EVENTS.agentWatchForwarded, {
      watchId: "w1",
      localAgentId: "local-a1",
      scope: "agent",
      sessionId: undefined,
      action: "start",
      requesterDeviceId: "user:sock-1",
    });
  });

  it("session scope 合法 → 登记到 sessionWatchers（不是 agentWatchers）", async () => {
    const { gateway } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1",
          userId: "u1",
          orgId: "org-1",
          deviceId: "dev-b",
          localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      {
        watchId: "w1",
        targetAgentId: "cloud-a1",
        scope: "session",
        sessionId: "s1",
      },
      client(),
    );
    expect(gateway.sessionWatcherIds("dev-b", "s1")).toEqual(["w1"]);
    expect(gateway.agentWatcherIds("dev-b", "local-a1")).toEqual([]);
  });

  it("多观察者登记到同一索引键（fan-out 前提）", async () => {
    const { gateway } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1",
          userId: "u1",
          orgId: "org-1",
          deviceId: "dev-b",
          localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      {
        watchId: "w1",
        targetAgentId: "cloud-a1",
        scope: "session",
        sessionId: "s1",
      },
      client({ id: "sock-1" }),
    );
    await gateway.handleAgentWatchStart(
      {
        watchId: "w2",
        targetAgentId: "cloud-a1",
        scope: "session",
        sessionId: "s1",
      },
      client({ id: "sock-2" }),
    );
    expect(gateway.sessionWatcherIds("dev-b", "s1").sort()).toEqual([
      "w1",
      "w2",
    ]);
  });

  it("显式 unwatch → 三表一致清空并通知设备 stop（泄漏防线 4）", async () => {
    const { gateway, server } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1",
          userId: "u1",
          orgId: "org-1",
          deviceId: "dev-b",
          localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      {
        watchId: "w1",
        targetAgentId: "cloud-a1",
        scope: "session",
        sessionId: "s1",
      },
      client(),
    );
    gateway.handleAgentWatchStop({ watchId: "w1" }, client());
    expect(gateway.watchRouteCount()).toBe(0);
    expect(gateway.sessionWatcherIds("dev-b", "s1")).toEqual([]);
    expect(server.emit).toHaveBeenCalledWith(
      IM_WS_EVENTS.agentWatchForwarded,
      expect.objectContaining({ watchId: "w1", action: "stop" }),
    );
  });

  it("unwatch 他人的 watchId 被拒（越权，路由不动）", async () => {
    const { gateway } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1",
          userId: "u1",
          orgId: "org-1",
          deviceId: "dev-b",
          localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      {
        watchId: "w1",
        targetAgentId: "cloud-a1",
        scope: "session",
        sessionId: "s1",
      },
      client({ id: "sock-1" }),
    );
    gateway.handleAgentWatchStop(
      { watchId: "w1" },
      client({ id: "别人的sock" }),
    );
    expect(gateway.watchRouteCount()).toBe(1);
  });

  it("unwatch 未知 watchId 静默无操作（不抛）", () => {
    const { gateway } = makeGateway({});
    expect(() =>
      gateway.handleAgentWatchStop({ watchId: "不存在" }, client()),
    ).not.toThrow();
  });
});
