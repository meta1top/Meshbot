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
  const gw = new ImGateway(
    {} as never, // jwt
    conversation as never,
    {} as never, // message
    presence as never, // presence
    {} as never, // userService
  );
  const fetchSockets = jest.fn().mockResolvedValue(overrides.sockets ?? []);
  const roomEmitSpy = jest.fn();
  const toSpy = jest.fn().mockReturnValue({ emit: roomEmitSpy });
  (gw as unknown as { server: unknown }).server = {
    in: jest.fn().mockReturnValue({ fetchSockets }),
    to: toSpy,
  };
  return { gw, conversation, presence, toSpy, roomEmitSpy };
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
    const client = { data: { user: { userId: "u1" } } }; // 无 orgId

    await gw.handlePresenceSet({ online: true } as never, client as never);

    expect(presence.setOnline).not.toHaveBeenCalled();
    expect(toSpy).not.toHaveBeenCalled();
  });
});
