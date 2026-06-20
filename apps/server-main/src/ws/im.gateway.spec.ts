import { IM_WS_EVENTS } from "@meshbot/types";
import { ImGateway } from "./im.gateway";

function makeGateway(overrides: {
  markReadReturn?: Date;
  sockets?: Array<{ data: { user?: { userId?: string } }; emit: jest.Mock }>;
}) {
  const conversation = {
    getVisibleOrThrow: jest.fn().mockResolvedValue({ id: "c1" }),
    markRead: jest
      .fn()
      .mockResolvedValue(
        overrides.markReadReturn ?? new Date("2026-06-20T00:00:00Z"),
      ),
  };
  const gw = new ImGateway(
    {} as never, // jwt
    conversation as never,
    {} as never, // message
    {} as never, // presence
    {} as never, // userService
  );
  const fetchSockets = jest.fn().mockResolvedValue(overrides.sockets ?? []);
  (gw as unknown as { server: unknown }).server = {
    in: jest.fn().mockReturnValue({ fetchSockets }),
  };
  return { gw, conversation };
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
