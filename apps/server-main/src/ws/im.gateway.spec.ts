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
  };
  userService?: {
    findById?: jest.Mock;
  };
  jwt?: {
    verify?: jest.Mock;
  };
  devices?: {
    verifyToken?: jest.Mock;
  };
  devicePresence?: {
    setOnline?: jest.Mock;
    setOffline?: jest.Mock;
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
  };
  const devicePresence = {
    setOnline:
      overrides.devicePresence?.setOnline ??
      jest.fn().mockResolvedValue(undefined),
    setOffline:
      overrides.devicePresence?.setOffline ??
      jest.fn().mockResolvedValue(undefined),
  };
  const gw = new ImGateway(
    jwt as never,
    conversation as never,
    {} as never, // message
    presence as never, // presence
    userService as never, // userService
    devices as never, // devices
    devicePresence as never, // devicePresence
  );
  const fetchSockets = jest.fn().mockResolvedValue(overrides.sockets ?? []);
  const roomEmitSpy = jest.fn();
  const toSpy = jest.fn().mockReturnValue({ emit: roomEmitSpy });
  (gw as unknown as { server: unknown }).server = {
    in: jest.fn().mockReturnValue({ fetchSockets }),
    to: toSpy,
  };
  return {
    gw,
    conversation,
    presence,
    userService,
    jwt,
    devices,
    devicePresence,
    toSpy,
    roomEmitSpy,
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
      userId: "agent:d1",
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
      userId: "agent:d1",
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
});
