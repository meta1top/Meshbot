import { IM_WS_EVENTS } from "@meshbot/types";
import { ImGateway } from "../src/ws/im.gateway";

/**
 * ImGateway.handleSend 的轻量断言测试（Task 4+5 Step 2）。
 *
 * 覆盖 device 反向通道回流 / Agent-DM 定向下发 / 普通会话不下发 三分支；
 * 手工 new ImGateway + mock conversation/message/server（不起真实 socket.io/DB）。
 * 完整端到端行为（真实双端连接 + presence 广播）由 Task 7 的
 * `apps/server-main/test/e2e/agent-dm-flow.e2e.spec.ts` 验证。
 */
function makeGateway(overrides: {
  conversation?: {
    getVisibleOrThrow?: jest.Mock;
    findAgentDevice?: jest.Mock;
  };
  message?: {
    persistMessage?: jest.Mock;
  };
}) {
  const conversation = {
    getVisibleOrThrow:
      overrides.conversation?.getVisibleOrThrow ??
      jest.fn().mockResolvedValue({ id: "c1" }),
    findAgentDevice:
      overrides.conversation?.findAgentDevice ??
      jest.fn().mockResolvedValue(null),
  };
  const message = {
    persistMessage:
      overrides.message?.persistMessage ??
      jest.fn().mockResolvedValue({
        id: "m1",
        conversationId: "c1",
        senderId: "u1",
        content: "hi",
        createdAt: "2026-07-02T00:00:00.000Z",
        senderType: "user",
      }),
  };
  const devicePresence = {
    setOnline: jest.fn().mockResolvedValue(undefined),
    setOffline: jest.fn().mockResolvedValue(undefined),
  };
  const gw = new ImGateway(
    {} as never, // jwt
    conversation as never,
    message as never,
    {} as never, // presence
    {} as never, // userService
    {} as never, // devices
    devicePresence as never,
  );
  const roomEmitSpy = jest.fn();
  const toSpy = jest.fn().mockReturnValue({ emit: roomEmitSpy });
  (gw as unknown as { server: unknown }).server = { to: toSpy };
  return { gw, conversation, message, devicePresence, toSpy, roomEmitSpy };
}

describe("ImGateway.handleSend（device 回流 / Agent-DM 定向下发）", () => {
  it("分支1：device 连接发消息 → persistMessage 收到 senderId=deviceId + senderType='agent'；不校验可见性", async () => {
    const { gw, conversation, message, toSpy, roomEmitSpy } = makeGateway({});
    const client = {
      data: { orgId: "org1", user: { userId: "u1", deviceId: "d1" } },
    };

    await gw.handleSend(
      { conversationId: "c1", content: "hi" } as never,
      client as never,
    );

    expect(conversation.getVisibleOrThrow).not.toHaveBeenCalled();
    expect(conversation.findAgentDevice).not.toHaveBeenCalled();
    expect(message.persistMessage).toHaveBeenCalledWith(
      "c1",
      "d1",
      "hi",
      "agent",
    );
    expect(toSpy).toHaveBeenCalledWith("conv:c1");
    expect(roomEmitSpy).toHaveBeenCalledWith(
      IM_WS_EVENTS.message,
      expect.objectContaining({ id: "m1" }),
    );
  });

  it("分支2：user 连接发到 Agent-DM 会话（findAgentDevice 返回 agentDeviceId）→ 定向下发 agentInbound 到 device room，payload 字段正确", async () => {
    const msg = {
      id: "m1",
      conversationId: "c1",
      senderId: "u1",
      content: "hi",
      createdAt: "2026-07-02T00:00:00.000Z",
      senderType: "user",
    };
    const { gw, conversation, message, toSpy, roomEmitSpy } = makeGateway({
      conversation: {
        findAgentDevice: jest.fn().mockResolvedValue({ agentDeviceId: "d9" }),
      },
      message: { persistMessage: jest.fn().mockResolvedValue(msg) },
    });
    const client = { data: { orgId: "org1", user: { userId: "u1" } } };

    await gw.handleSend(
      { conversationId: "c1", content: "hi" } as never,
      client as never,
    );

    expect(conversation.getVisibleOrThrow).toHaveBeenCalledWith(
      "c1",
      "u1",
      "org1",
    );
    expect(message.persistMessage).toHaveBeenCalledWith(
      "c1",
      "u1",
      "hi",
      "user",
    );
    expect(toSpy).toHaveBeenCalledWith("conv:c1");
    expect(toSpy).toHaveBeenCalledWith("device:d9");
    expect(roomEmitSpy).toHaveBeenCalledWith(IM_WS_EVENTS.agentInbound, {
      conversationId: "c1",
      messageId: "m1",
      content: "hi",
      senderUserId: "u1",
    });
  });

  it("分支3：user 连接发到普通会话（findAgentDevice 返回 null）→ 不 emit agentInbound", async () => {
    const { gw, conversation, toSpy, roomEmitSpy } = makeGateway({
      conversation: { findAgentDevice: jest.fn().mockResolvedValue(null) },
    });
    const client = { data: { orgId: "org1", user: { userId: "u1" } } };

    await gw.handleSend(
      { conversationId: "c1", content: "hi" } as never,
      client as never,
    );

    expect(conversation.findAgentDevice).toHaveBeenCalledWith("c1");
    expect(toSpy).toHaveBeenCalledWith("conv:c1");
    expect(roomEmitSpy).not.toHaveBeenCalledWith(
      IM_WS_EVENTS.agentInbound,
      expect.anything(),
    );
  });
});
