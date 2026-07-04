import { AppError } from "@meshbot/common";
import { MainErrorCode } from "@meshbot/main";
import { IM_WS_EVENTS } from "@meshbot/types";
import { ImGateway } from "../src/ws/im.gateway";

/**
 * ImGateway.handleSend 的轻量断言测试（Task 4+5 Step 2 + FIX2 device 对象级授权）。
 *
 * 覆盖 device 反向通道回流 / Agent-DM 定向下发 / 普通会话不下发 三分支，
 * 外加 FIX2：device 分支落库前 getAgentDmOrThrow + agentDeviceId/orgId 归属断言；
 * 手工 new ImGateway + mock conversation/message/server（不起真实 socket.io/DB）。
 * 完整端到端行为（真实双端连接 + presence 广播）由 Task 7 的
 * `apps/server-main/test/e2e/agent-dm-flow.e2e.spec.ts` 验证。
 */
function makeGateway(overrides: {
  conversation?: {
    getVisibleOrThrow?: jest.Mock;
    findAgentDevice?: jest.Mock;
    getAgentDmOrThrow?: jest.Mock;
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
    getAgentDmOrThrow:
      overrides.conversation?.getAgentDmOrThrow ??
      jest
        .fn()
        .mockResolvedValue({ id: "c1", agentDeviceId: "d1", orgId: "org1" }),
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
  it("分支1：device 连接发到自己的 Agent-DM → getAgentDmOrThrow 断言归属通过 → persistMessage senderId=deviceId + senderType='agent'；不校验可见性", async () => {
    const { gw, conversation, message, toSpy, roomEmitSpy } = makeGateway({});
    const client = {
      data: { orgId: "org1", user: { userId: "u1", deviceId: "d1" } },
    };

    await gw.handleSend(
      { conversationId: "c1", content: "hi" } as never,
      client as never,
    );

    // FIX2：device 分支落库前先断言该会话是本设备的 Agent-DM（对象级授权）
    expect(conversation.getAgentDmOrThrow).toHaveBeenCalledWith("c1");
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

  it("FIX2 越权：device 连接发到「非本设备」的 Agent-DM（agentDeviceId 不匹配）→ 抛 CONVERSATION_FORBIDDEN，不落库不广播", async () => {
    const persistMessage = jest.fn();
    const { gw, message, toSpy } = makeGateway({
      conversation: {
        // 该会话是 Agent-DM，但属于另一台设备 d-other
        getAgentDmOrThrow: jest.fn().mockResolvedValue({
          id: "c1",
          agentDeviceId: "d-other",
          orgId: "org1",
        }),
      },
      message: { persistMessage },
    });
    const client = {
      data: { orgId: "org1", user: { userId: "u1", deviceId: "d1" } },
    };

    await expect(
      gw.handleSend(
        { conversationId: "c1", content: "hi" } as never,
        client as never,
      ),
    ).rejects.toMatchObject({
      errorCode: MainErrorCode.CONVERSATION_FORBIDDEN,
    });

    expect(message.persistMessage).not.toHaveBeenCalled();
    expect(toSpy).not.toHaveBeenCalled();
  });

  it("FIX2 越权：device 连接发到「非 Agent-DM」会话（getAgentDmOrThrow 抛 AGENT_DEVICE_INVALID）→ 透传抛出，不落库", async () => {
    const persistMessage = jest.fn();
    const { gw, message, toSpy } = makeGateway({
      conversation: {
        getAgentDmOrThrow: jest
          .fn()
          .mockRejectedValue(new AppError(MainErrorCode.AGENT_DEVICE_INVALID)),
      },
      message: { persistMessage },
    });
    const client = {
      data: { orgId: "org1", user: { userId: "u1", deviceId: "d1" } },
    };

    await expect(
      gw.handleSend(
        { conversationId: "c1", content: "hi" } as never,
        client as never,
      ),
    ).rejects.toMatchObject({
      errorCode: MainErrorCode.AGENT_DEVICE_INVALID,
    });

    expect(message.persistMessage).not.toHaveBeenCalled();
    expect(toSpy).not.toHaveBeenCalled();
  });

  it("FIX2 越权：device 连接发到「跨 org」的本设备 Agent-DM（orgId 不匹配）→ 抛 CONVERSATION_FORBIDDEN，不落库", async () => {
    const persistMessage = jest.fn();
    const { gw, message, toSpy } = makeGateway({
      conversation: {
        // agentDeviceId 匹配本设备，但会话 org 与连接 org 不一致
        getAgentDmOrThrow: jest.fn().mockResolvedValue({
          id: "c1",
          agentDeviceId: "d1",
          orgId: "org-other",
        }),
      },
      message: { persistMessage },
    });
    const client = {
      data: { orgId: "org1", user: { userId: "u1", deviceId: "d1" } },
    };

    await expect(
      gw.handleSend(
        { conversationId: "c1", content: "hi" } as never,
        client as never,
      ),
    ).rejects.toMatchObject({
      errorCode: MainErrorCode.CONVERSATION_FORBIDDEN,
    });

    expect(message.persistMessage).not.toHaveBeenCalled();
    expect(toSpy).not.toHaveBeenCalled();
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
