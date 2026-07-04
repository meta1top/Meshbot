import { AccountContextService } from "@meshbot/agent";
import { AgentInboxService, NO_REPLY_TEXT } from "./agent-inbox.service";

/** 反复 await Promise.resolve() 排空微任务队列。 */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function make() {
  const imAgentSession = {
    findByConversation: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(undefined),
    advanceCursor: jest.fn().mockResolvedValue(undefined),
    getCursor: jest.fn().mockResolvedValue(null),
    advanceAppended: jest.fn().mockResolvedValue(undefined),
    getAppended: jest.fn().mockResolvedValue(null),
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
  const cloudIm = {
    listAgentConversations: jest.fn().mockResolvedValue([]),
    getMessages: jest.fn().mockResolvedValue({ messages: [], hasMore: false }),
  };
  const account = new AccountContextService();
  const svc = new AgentInboxService(
    imAgentSession as never,
    sessions as never,
    runner as never,
    messages as never,
    relay as never,
    cloudIm as never,
    account,
  );
  return {
    svc,
    imAgentSession,
    sessions,
    runner,
    messages,
    relay,
    cloudIm,
    account,
  };
}

/** 直接调用私有 catchUp（绕开 fire-and-forget 的 @OnEvent 包装，测试无需 flush）。 */
function callCatchUp(
  svc: AgentInboxService,
  cloudUserId: string,
): Promise<void> {
  return (
    svc as unknown as { catchUp(cloudUserId: string): Promise<void> }
  ).catchUp(cloudUserId);
}

/**
 * 直接经 serialize 驱动私有 process（模拟 catchUp 读到旧游标、已把该条纳入 fresh
 * 后排队进来的那次 process 调用）——用于验证 FIX3 process 串行段起始重读游标短路。
 */
function callProcess(
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
  const inner = svc as unknown as {
    serialize(key: string, fn: () => Promise<void>): Promise<void>;
    process(cloudUserId: string, payload: unknown): Promise<void>;
  };
  return account.run(cloudUserId, () =>
    inner.serialize(payload.conversationId, () =>
      inner.process(cloudUserId, payload),
    ),
  );
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
    expect(imAgentSession.advanceAppended).toHaveBeenCalledWith(
      "conv-1",
      "msg-1",
    );
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
    expect(imAgentSession.advanceAppended).toHaveBeenCalledWith(
      "conv-1",
      "msg-2",
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

    // T10 Minor 补：即便 relay.send 自己也抛错，也应确认它确实被调用过
    // （不是被跳过），且这不影响 advanceCursor 仍然推进。
    expect(relay.send).toHaveBeenCalledTimes(1);
    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-1",
      "msg-4",
    );
  });

  it("run 成功但 findLastAssistant 为 null：用 NO_REPLY_TEXT 兜底文案回流", async () => {
    const { svc, imAgentSession, messages, relay, account } = make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s-existing",
      conversationId: "conv-1",
    });
    messages.findLastAssistant.mockResolvedValue(null);

    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-6",
      content: "无回复场景",
      senderUserId: "peer-1",
    });

    expect(relay.send).toHaveBeenCalledWith("u1", {
      conversationId: "conv-1",
      content: NO_REPLY_TEXT,
    });
    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-1",
      "msg-6",
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

describe("AgentInboxService 游标语义修正（Task 11 必修）", () => {
  it("run 成功但投递失败（relay 未连）：不推进处理游标；重投同一条消息不 dup-append，投递成功后游标推进", async () => {
    const { svc, imAgentSession, sessions, runner, messages, relay, account } =
      make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s-existing",
      conversationId: "conv-1",
    });
    messages.findLastAssistant.mockResolvedValue({ content: "计算好的回复" });
    relay.send.mockImplementationOnce(() => {
      throw new Error("IM_NOT_CONNECTED");
    });

    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-5",
      content: "问一句",
      senderUserId: "peer-1",
    });

    // run 成功但投递失败：处理游标不推进
    expect(imAgentSession.advanceCursor).not.toHaveBeenCalled();
    expect(sessions.appendMessage).toHaveBeenCalledTimes(1);
    expect(imAgentSession.advanceAppended).toHaveBeenCalledWith(
      "conv-1",
      "msg-5",
    );

    // 模拟补处理重投同一条消息（messageId 不变）：append 游标已推进 →
    // resolveSession 应跳过 append，不再重复调用 appendMessage / kickAndWait 之前的准备。
    imAgentSession.getAppended.mockResolvedValue("msg-5");
    sessions.appendMessage.mockClear();
    runner.kickAndWait.mockClear();
    relay.send.mockClear();

    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-5",
      content: "问一句",
      senderUserId: "peer-1",
    });

    expect(sessions.appendMessage).not.toHaveBeenCalled(); // 不 dup-append
    expect(runner.kickAndWait).toHaveBeenCalledTimes(1);
    expect(relay.send).toHaveBeenCalledWith("u1", {
      conversationId: "conv-1",
      content: "计算好的回复",
    });
    // 这次投递成功：处理游标推进
    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-1",
      "msg-5",
    );
  });

  it("resolveSession 失败（如 findByConversation 抛错）：process 不抛出，best-effort 回错误文案并推进处理游标", async () => {
    // 回归保护：process 是 @OnEvent(handleInbound) 的下游 fire-and-forget 调用，
    // 一旦某一步（哪怕是 resolveSession 这种"找/建会话"阶段）意外抛出且没被
    // 兜住，会变成未捕获的 promise rejection。两段游标重构必须保留原 T10 的
    // "process 全程不抛出"不变量。
    const { svc, imAgentSession, runner, relay, account } = make();
    imAgentSession.findByConversation.mockRejectedValue(
      new Error("DB 连接失败"),
    );

    await expect(
      inbound(svc, account, "u1", {
        conversationId: "conv-1",
        messageId: "msg-8",
        content: "触发 resolveSession 失败",
        senderUserId: "peer-1",
      }),
    ).resolves.toBeUndefined();

    expect(runner.kickAndWait).not.toHaveBeenCalled();
    expect(relay.send).toHaveBeenCalledTimes(1);
    const [, sendInput] = relay.send.mock.calls[0];
    expect(sendInput.content).toContain("DB 连接失败");
    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-1",
      "msg-8",
    );
  });

  it("run 失败：处理游标无条件推进（不受投递结果影响）——三条路径之一", async () => {
    const { svc, imAgentSession, runner, relay, account } = make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s-existing",
      conversationId: "conv-1",
    });
    runner.kickAndWait.mockRejectedValue(new Error("崩了"));

    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-7",
      content: "会崩的一条",
      senderUserId: "peer-1",
    });

    expect(relay.send).toHaveBeenCalledTimes(1);
    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-1",
      "msg-7",
    );
  });
});

describe("AgentInboxService.catchUp（重连/启动补处理）", () => {
  it("枚举 2 个会话：会话 A 游标之后有 2 条 user 消息，各触发一次 process（kickAndWait 2 次）且游标推进到最后一条；会话 B 无新消息不处理", async () => {
    const { svc, imAgentSession, runner, messages, cloudIm } = make();
    imAgentSession.findByConversation.mockImplementation(
      async (conversationId: string) => ({
        sessionId: `s-${conversationId}`,
        conversationId,
      }),
    );
    imAgentSession.getCursor.mockImplementation(
      async (conversationId: string) =>
        conversationId === "conv-A" ? "msg-0" : "msg-99",
    );
    messages.findLastAssistant.mockResolvedValue({ content: "ok" });

    cloudIm.listAgentConversations.mockResolvedValue([
      { conversationId: "conv-A", orgId: "org1" },
      { conversationId: "conv-B", orgId: "org1" },
    ]);
    cloudIm.getMessages.mockImplementation(async (conversationId: string) => {
      if (conversationId === "conv-A") {
        return {
          messages: [
            {
              id: "msg-1",
              conversationId,
              senderId: "peer-1",
              content: "A1",
              createdAt: "2026-01-01T00:00:01.000Z",
              senderType: "user",
            },
            {
              id: "msg-2",
              conversationId,
              senderId: "peer-1",
              content: "A2",
              createdAt: "2026-01-01T00:00:02.000Z",
              senderType: "user",
            },
          ],
          hasMore: false,
        };
      }
      return { messages: [], hasMore: false };
    });

    await callCatchUp(svc, "u1");

    expect(cloudIm.getMessages).toHaveBeenCalledWith("conv-A", undefined, "50");
    expect(cloudIm.getMessages).toHaveBeenCalledWith("conv-B", undefined, "50");
    expect(runner.kickAndWait).toHaveBeenCalledTimes(2);
    expect(runner.kickAndWait).toHaveBeenNthCalledWith(1, "s-conv-A");
    expect(runner.kickAndWait).toHaveBeenNthCalledWith(2, "s-conv-A");
    expect(imAgentSession.advanceCursor).toHaveBeenCalledWith(
      "conv-A",
      "msg-2",
    );
    // 会话 B 无新消息：不触发处理
    expect(runner.kickAndWait).not.toHaveBeenCalledWith("s-conv-B");
  });

  it("实时 inbound 已处理的消息，catchUp 补处理因游标过滤而跳过（不双处理）", async () => {
    const { svc, imAgentSession, runner, messages, relay, cloudIm, account } =
      make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s1",
      conversationId: "conv-1",
    });
    messages.findLastAssistant.mockResolvedValue({ content: "ok" });

    let cursor: string | null = null;
    imAgentSession.getCursor.mockImplementation(async () => cursor);
    imAgentSession.advanceCursor.mockImplementation(
      async (_conversationId: string, messageId: string) => {
        cursor = messageId;
      },
    );

    // 实时 inbound 先处理了 msg-1，处理游标推进到 msg-1
    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-1",
      content: "你好",
      senderUserId: "peer-1",
    });
    expect(cursor).toBe("msg-1");

    runner.kickAndWait.mockClear();
    relay.send.mockClear();

    cloudIm.listAgentConversations.mockResolvedValue([
      { conversationId: "conv-1", orgId: "org1" },
    ]);
    cloudIm.getMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-1",
          conversationId: "conv-1",
          senderId: "peer-1",
          content: "你好",
          createdAt: "2026-01-01T00:00:01.000Z",
          senderType: "user",
        },
      ],
      hasMore: false,
    });

    await callCatchUp(svc, "u1");

    expect(runner.kickAndWait).not.toHaveBeenCalled();
    expect(relay.send).not.toHaveBeenCalled();
  });

  it("真并发双触发（runtimeCreated 与 connected 首连重叠）：第一次卡在 getMessages 时第二次进来，账号级 in-flight 去重合并，同一消息只投递一次", async () => {
    const { svc, imAgentSession, sessions, runner, messages, relay, cloudIm } =
      make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s1",
      conversationId: "conv-1",
    });
    messages.findLastAssistant.mockResolvedValue({ content: "ok" });

    // 游标真实推进（catchUp 内部处理成功后才推进），验证去重不是靠游标而是靠 in-flight 合并
    let cursor: string | null = null;
    imAgentSession.getCursor.mockImplementation(async () => cursor);
    imAgentSession.advanceCursor.mockImplementation(
      async (_conversationId: string, messageId: string) => {
        cursor = messageId;
      },
    );
    let appended: string | null = null;
    imAgentSession.getAppended.mockImplementation(async () => appended);
    imAgentSession.advanceAppended.mockImplementation(
      async (_conversationId: string, messageId: string) => {
        appended = messageId;
      },
    );

    cloudIm.listAgentConversations.mockResolvedValue([
      { conversationId: "conv-1", orgId: "org1" },
    ]);
    // 让第一次 catchUp 卡在 getMessages（模拟网络往返未回），期间触发第二次。
    // 用对象持有 resolver，避开 TS 对闭包内赋值的 let 的控制流收窄。
    const deferred: { release?: () => void } = {};
    let getMessagesCalls = 0;
    cloudIm.getMessages.mockImplementation(() => {
      getMessagesCalls++;
      return new Promise((resolve) => {
        deferred.release = () =>
          resolve({
            messages: [
              {
                id: "msg-1",
                conversationId: "conv-1",
                senderId: "peer-1",
                content: "你好",
                createdAt: "2026-01-01T00:00:01.000Z",
                senderType: "user",
              },
            ],
            hasMore: false,
          });
      });
    });

    // 首连：runtimeCreated 先触发（catchUp 进入、卡在 getMessages），connected 紧接触发
    const p1 = callCatchUp(svc, "u1");
    await flush();
    // 第一次已进入 getMessages
    expect(getMessagesCalls).toBe(1);

    const p2 = callCatchUp(svc, "u1");
    await flush();
    // 第二次被 in-flight 去重合并，未再发起 getMessages
    expect(getMessagesCalls).toBe(1);

    deferred.release?.();
    await Promise.all([p1, p2]);

    // 同一条 msg-1 只 append/run/投递一次（不因双触发重发）
    expect(sessions.appendMessage).toHaveBeenCalledTimes(1);
    expect(runner.kickAndWait).toHaveBeenCalledTimes(1);
    expect(relay.send).toHaveBeenCalledTimes(1);
    // 去重后可再次触发（此时前一次已结束、游标已推进到 msg-1）：走游标幂等过滤，不再投递
    cloudIm.getMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-1",
          conversationId: "conv-1",
          senderId: "peer-1",
          content: "你好",
          createdAt: "2026-01-01T00:00:01.000Z",
          senderType: "user",
        },
      ],
      hasMore: false,
    });
    await callCatchUp(svc, "u1");
    expect(relay.send).toHaveBeenCalledTimes(1);
  });

  it("两次顺序 catchUp（前一次完全跑完后再触发）：游标已推进，第二次被 getCursor 过滤，不重复投递", async () => {
    const { svc, imAgentSession, sessions, runner, messages, relay, cloudIm } =
      make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s1",
      conversationId: "conv-1",
    });
    messages.findLastAssistant.mockResolvedValue({ content: "ok" });

    let cursor: string | null = null;
    imAgentSession.getCursor.mockImplementation(async () => cursor);
    imAgentSession.advanceCursor.mockImplementation(
      async (_conversationId: string, messageId: string) => {
        cursor = messageId;
      },
    );
    let appended: string | null = null;
    imAgentSession.getAppended.mockImplementation(async () => appended);
    imAgentSession.advanceAppended.mockImplementation(
      async (_conversationId: string, messageId: string) => {
        appended = messageId;
      },
    );

    cloudIm.listAgentConversations.mockResolvedValue([
      { conversationId: "conv-1", orgId: "org1" },
    ]);
    cloudIm.getMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-1",
          conversationId: "conv-1",
          senderId: "peer-1",
          content: "你好",
          createdAt: "2026-01-01T00:00:01.000Z",
          senderType: "user",
        },
      ],
      hasMore: false,
    });

    await callCatchUp(svc, "u1");
    await callCatchUp(svc, "u1");

    // 第一次处理 msg-1 并推进游标；第二次 getCursor 已是 msg-1，被过滤掉。
    expect(sessions.appendMessage).toHaveBeenCalledTimes(1);
    expect(runner.kickAndWait).toHaveBeenCalledTimes(1);
    expect(relay.send).toHaveBeenCalledTimes(1);
  });

  it("onRuntimeCreated / onRelayConnected 事件都会触发 catchUp（fire-and-forget）", async () => {
    const { svc, account } = make();
    const catchUpSpy = jest
      .spyOn(
        svc as unknown as { catchUp: (cloudUserId: string) => Promise<void> },
        "catchUp",
      )
      .mockResolvedValue(undefined);

    svc.onRuntimeCreated({ cloudUserId: "u1" });
    await flush();
    expect(catchUpSpy).toHaveBeenCalledWith("u1");

    catchUpSpy.mockClear();
    svc.onRelayConnected({ cloudUserId: "u2" });
    await flush();
    expect(catchUpSpy).toHaveBeenCalledWith("u2");

    // 事件处理器内的 account.run 应带上对应 cloudUserId 的账号上下文
    expect(account.get()).toBeNull(); // fire-and-forget 结束后回到无上下文
  });

  it("枚举会话失败：只记日志，不抛出", async () => {
    const { svc, cloudIm } = make();
    cloudIm.listAgentConversations.mockRejectedValue(new Error("网络错误"));

    await expect(callCatchUp(svc, "u1")).resolves.toBeUndefined();
  });

  it("并发：同一会话的 catchUp 与实时 inbound 同时触发，serialize 锁保证不并发跑两个 kickAndWait", async () => {
    const { svc, imAgentSession, runner, messages, cloudIm, account } = make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s1",
      conversationId: "conv-1",
    });
    messages.findLastAssistant.mockResolvedValue({ content: "ok" });

    cloudIm.listAgentConversations.mockResolvedValue([
      { conversationId: "conv-1", orgId: "org1" },
    ]);
    cloudIm.getMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-2",
          conversationId: "conv-1",
          senderId: "peer-1",
          content: "补处理这条",
          createdAt: "2026-01-01T00:00:02.000Z",
          senderType: "user",
        },
      ],
      hasMore: false,
    });

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

    // 实时 inbound 先进入（占住 conv-1 的串行锁）
    const p1 = inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-1",
      content: "第一条",
      senderUserId: "peer-1",
    });
    await flush();
    expect(releasers).toHaveLength(1);

    // catchUp 几乎同时触发，理应被 serialize 锁挡住，等第一条跑完才轮到
    const p2 = callCatchUp(svc, "u1");
    await flush();
    expect(releasers).toHaveLength(1); // 未新增：catchUp 还没进 kickAndWait

    releasers[0]();
    await flush();
    await p1;

    expect(releasers).toHaveLength(2); // 第一条跑完，catchUp 的这条才进入
    releasers[1]();
    await flush();
    await p2;

    expect(order).toEqual(["start:s1", "end:s1", "start:s1", "end:s1"]);
  });
});

describe("AgentInboxService FIX3：process 串行段起始重读游标短路重投", () => {
  it("同会话 catchUp 与实时 inbound 同一 messageId：实时先跑推进游标，catchUp 排队进来的 process 重读游标被短路（不 kickAndWait/不 relay.send 重投）", async () => {
    const { svc, imAgentSession, sessions, runner, messages, relay, account } =
      make();
    imAgentSession.findByConversation.mockResolvedValue({
      sessionId: "s1",
      conversationId: "conv-1",
    });
    messages.findLastAssistant.mockResolvedValue({ content: "回复" });

    // 游标 / append 游标可变，随处理推进
    let cursor: string | null = null;
    imAgentSession.getCursor.mockImplementation(async () => cursor);
    imAgentSession.advanceCursor.mockImplementation(
      async (_conversationId: string, messageId: string) => {
        cursor = messageId;
      },
    );
    let appended: string | null = null;
    imAgentSession.getAppended.mockImplementation(async () => appended);
    imAgentSession.advanceAppended.mockImplementation(
      async (_conversationId: string, messageId: string) => {
        appended = messageId;
      },
    );

    // 实时 inbound msg-1 先跑：kickAndWait + relay.send 各一次，游标推进到 msg-1
    await inbound(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-1",
      content: "你好",
      senderUserId: "peer-1",
    });
    expect(cursor).toBe("msg-1");
    expect(runner.kickAndWait).toHaveBeenCalledTimes(1);
    expect(relay.send).toHaveBeenCalledTimes(1);

    runner.kickAndWait.mockClear();
    relay.send.mockClear();
    sessions.appendMessage.mockClear();

    // catchUp 读到旧游标已把 msg-1 纳入 fresh，排队进来的 process(msg-1)：
    // 串行段起始重读 getCursor 现在已是 msg-1（msg-1 <= msg-1）→ 短路，
    // 不 kickAndWait、不 findLastAssistant、不 relay.send（避免重复回复）
    messages.findLastAssistant.mockClear();
    await callProcess(svc, account, "u1", {
      conversationId: "conv-1",
      messageId: "msg-1",
      content: "你好",
      senderUserId: "peer-1",
    });

    expect(runner.kickAndWait).not.toHaveBeenCalled();
    expect(messages.findLastAssistant).not.toHaveBeenCalled();
    expect(relay.send).not.toHaveBeenCalled();
    expect(sessions.appendMessage).not.toHaveBeenCalled();
  });
});
