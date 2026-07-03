import { AccountContextService } from "@meshbot/agent";
import { AgentInboxService } from "./agent-inbox.service";

/** 反复 await Promise.resolve() 排空微任务队列。 */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function make() {
  const imAgentSession = {
    findByConversation: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(undefined),
    advanceCursor: jest.fn().mockResolvedValue(undefined),
  };
  const sessions = {
    createImAgentSession: jest
      .fn()
      .mockResolvedValue({ sessionId: "s1", session: { id: "s1" } }),
    appendMessage: jest
      .fn()
      .mockResolvedValue({ messageId: "m-appended", queued: true }),
  };
  const runner = {
    kickAndWait: jest.fn().mockResolvedValue(undefined),
  };
  const messages = {
    findLastAssistant: jest.fn().mockResolvedValue({ content: "Agent 回复" }),
  };
  const relay = {
    send: jest.fn(),
  };
  const account = new AccountContextService();
  const svc = new AgentInboxService(
    imAgentSession as never,
    sessions as never,
    runner as never,
    messages as never,
    relay as never,
    account,
  );
  return { svc, imAgentSession, sessions, runner, messages, relay, account };
}

/** relay 下行事件真实场景：emitter.emit 在 account.run(cloudUserId, ...) 内触发。 */
function inbound(
  svc: AgentInboxService,
  account: AccountContextService,
  cloudUserId: string,
  payload: {
    conversationId: string;
    messageId: string;
    content: string;
    senderUserId: string;
  },
): Promise<void> {
  return account.run(cloudUserId, () => svc.handleInbound(payload));
}

describe("AgentInboxService.handleInbound", () => {
  it("首次 inbound：建本地会话 + 建映射 + kickAndWait + 回流 + 推进游标", async () => {
    const { svc, imAgentSession, sessions, runner, messages, relay, account } =
      make();

    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-1",
      content: "你好",
      senderUserId: "peer-1",
    });

    expect(imAgentSession.findByConversation).toHaveBeenCalledWith("conv-1");
    expect(sessions.createImAgentSession).toHaveBeenCalledWith("你好");
    expect(sessions.appendMessage).not.toHaveBeenCalled();
    expect(imAgentSession.create).toHaveBeenCalledWith("conv-1", "s1");
    expect(runner.kickAndWait).toHaveBeenCalledWith("s1");
    expect(messages.findLastAssistant).toHaveBeenCalledWith("s1");
    expect(relay.send).toHaveBeenCalledWith("u1", {
      conversationId: "conv-1",
      content: "Agent 回复",
    });
    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-1",
      "msg-1",
    );
  });

  it("二次 inbound（已有映射）：appendMessage 到既有会话，不再 createImAgentSession", async () => {
    const { svc, imAgentSession, sessions, runner, messages, relay, account } =
      make();
    imAgentSession.findByConversation.mockResolvedValue({
      id: "map-1",
      conversationId: "conv-1",
      sessionId: "s-existing",
      cloudUserId: "u1",
      lastProcessedMessageId: "msg-0",
    });

    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-2",
      content: "继续",
      senderUserId: "peer-1",
    });

    expect(sessions.createImAgentSession).not.toHaveBeenCalled();
    expect(imAgentSession.create).not.toHaveBeenCalled();
    expect(sessions.appendMessage).toHaveBeenCalledWith(
      "s-existing",
      expect.objectContaining({ content: "继续" }),
    );
    // messageId 由本服务生成（appendMessage 的入参要求非空 messageId）
    expect(sessions.appendMessage.mock.calls[0][1].messageId).toEqual(
      expect.any(String),
    );
    expect(runner.kickAndWait).toHaveBeenCalledWith("s-existing");
    expect(messages.findLastAssistant).toHaveBeenCalledWith("s-existing");
    expect(relay.send).toHaveBeenCalledWith("u1", {
      conversationId: "conv-1",
      content: "Agent 回复",
    });
    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-1",
      "msg-2",
    );
  });

  it("run 失败（kickAndWait 抛）：relay.send 收到错误文案，advanceCursor 仍被调用", async () => {
    const { svc, imAgentSession, runner, messages, relay, account } = make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s-existing",
      conversationId: "conv-1",
    });
    runner.kickAndWait.mockRejectedValue(new Error("run 崩溃"));

    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-3",
      content: "触发失败",
      senderUserId: "peer-1",
    });

    expect(messages.findLastAssistant).not.toHaveBeenCalled();
    expect(relay.send).toHaveBeenCalledTimes(1);
    const [cloudUserId, sendInput] = relay.send.mock.calls[0];
    expect(cloudUserId).toBe("u1");
    expect(sendInput.conversationId).toBe("conv-1");
    expect(sendInput.content).toContain("run 崩溃");
    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-1",
      "msg-3",
    );
  });

  it("relay.send 在失败分支也抛出（未连接）时不影响 advanceCursor 仍被调用", async () => {
    const { svc, imAgentSession, runner, relay, account } = make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s-existing",
      conversationId: "conv-1",
    });
    runner.kickAndWait.mockRejectedValue(new Error("run 崩溃"));
    relay.send.mockImplementation(() => {
      throw new Error("IM_NOT_CONNECTED");
    });

    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-4",
      content: "触发失败",
      senderUserId: "peer-1",
    });

    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-1",
      "msg-4",
    );
  });

  it("同一 conversationId 并发两条 inbound：串行处理，第二条的 kickAndWait 在第一条完成后才发起", async () => {
    const { svc, imAgentSession, runner, messages, account } = make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s1",
      conversationId: "conv-1",
    });
    messages.findLastAssistant.mockResolvedValue({ content: "ok" });

    const order: string[] = [];
    const releasers: Array<() => void> = [];
    runner.kickAndWait.mockImplementation((sessionId: string) => {
      order.push(`start:${sessionId}`);
      return new Promise<void>((resolve) => {
        releasers.push(() => {
          order.push(`end:${sessionId}`);
          resolve();
        });
      });
    });

    const p1 = inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-a",
      content: "第一条",
      senderUserId: "peer-1",
    });
    await flush();
    // 第一条已进入 kickAndWait
    expect(releasers).toHaveLength(1);

    const p2 = inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-b",
      content: "第二条",
      senderUserId: "peer-1",
    });
    await flush();
    // 第二条被串行阻塞：不应该在第一条完成前就调用 kickAndWait
    expect(releasers).toHaveLength(1);

    releasers[0]();
    await flush();
    await p1;

    // 第一条完成后，第二条才进入 kickAndWait
    expect(releasers).toHaveLength(2);

    releasers[1]();
    await p2;

    expect(order).toEqual(["start:s1", "end:s1", "start:s1", "end:s1"]);
  });

  it("不同 conversationId 并发 inbound：互不阻塞（各自独立串行链）", async () => {
    const { svc, imAgentSession, runner, messages, account } = make();
    imAgentSession.findByConversation.mockImplementation(
      async (conversationId: string) => ({
        sessionId: `s-${conversationId}`,
        conversationId,
      }),
    );
    messages.findLastAssistant.mockResolvedValue({ content: "ok" });

    const releasers: Array<() => void> = [];
    runner.kickAndWait.mockImplementation(() => {
      return new Promise<void>((resolve) => {
        releasers.push(resolve);
      });
    });

    const p1 = inbound(svc, account, "u1", {
      conversationId: "conv-a",
      messageId: "msg-a",
      content: "A",
      senderUserId: "peer-1",
    });
    const p2 = inbound(svc, account, "u1", {
      conversationId: "conv-b",
      messageId: "msg-b",
      content: "B",
      senderUserId: "peer-1",
    });
    await flush();

    // 不同会话互不阻塞：两条都应已进入各自的 kickAndWait
    expect(releasers).toHaveLength(2);

    releasers.forEach((r) => {
      r();
    });
    await Promise.all([p1, p2]);
  });
});
