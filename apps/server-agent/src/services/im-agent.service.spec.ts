import { ImAgentService } from "./im-agent.service";

function makeSvc(opts: {
  convType: "channel" | "dm";
  selfId: string;
  agentEnabled?: boolean;
}) {
  const appended: { sessionId: string; content: string }[] = [];
  const kicked: string[] = [];
  const companion = {
    id: "comp-1",
    imConvType: opts.convType,
    agentEnabled: opts.agentEnabled ?? true,
  };
  const sessions: any = {
    findOrCreateImCompanion: jest.fn().mockResolvedValue(companion),
    appendMessage: jest.fn(async (sid: string, m: any) => {
      appended.push({ sessionId: sid, content: m.content });
      return { messageId: m.messageId, queued: false };
    }),
  };
  const runner: any = { kick: jest.fn((sid: string) => kicked.push(sid)) };
  const cloudIm: any = {
    listConversations: jest.fn().mockResolvedValue([
      {
        id: "conv-1",
        type: opts.convType,
        name: "X",
        peer: opts.convType === "dm" ? { displayName: "对端" } : null,
      },
    ]),
  };
  const identity: any = {
    get: jest.fn().mockResolvedValue({
      cloudUserId: opts.selfId,
      displayName: "Grant",
      email: "grant@x.com",
    }),
  };
  const account: any = { get: jest.fn().mockReturnValue(opts.selfId) };
  const svc = new ImAgentService(sessions, runner, cloudIm, identity, account);
  return { svc, appended, kicked, sessions, runner };
}

describe("ImAgentService.onImMessage", () => {
  it("私信对端消息：摄入 + kick", async () => {
    const { svc, appended, kicked } = makeSvc({ convType: "dm", selfId: "me" });
    await svc.onImMessage({
      id: "m1",
      conversationId: "conv-1",
      senderId: "peer",
      content: "在吗",
      createdAt: "t",
    });
    expect(appended).toHaveLength(1);
    expect(kicked).toEqual(["comp-1"]);
  });
  it("私信自己消息：只摄入不 kick", async () => {
    const { svc, appended, kicked } = makeSvc({ convType: "dm", selfId: "me" });
    await svc.onImMessage({
      id: "m2",
      conversationId: "conv-1",
      senderId: "me",
      content: "在",
      createdAt: "t",
    });
    expect(appended).toHaveLength(1);
    expect(kicked).toEqual([]);
  });
  it("频道未@：只摄入不 kick；@自己：kick", async () => {
    const a = makeSvc({ convType: "channel", selfId: "me" });
    await a.svc.onImMessage({
      id: "m3",
      conversationId: "conv-1",
      senderId: "peer",
      content: "大家好",
      createdAt: "t",
    });
    expect(a.kicked).toEqual([]);
    const b = makeSvc({ convType: "channel", selfId: "me" });
    await b.svc.onImMessage({
      id: "m4",
      conversationId: "conv-1",
      senderId: "peer",
      content: "@Grant 看下",
      createdAt: "t",
    });
    expect(b.kicked).toEqual(["comp-1"]);
  });
  it("开关关：摄入也跳过、不 kick", async () => {
    const { svc, appended, kicked } = makeSvc({
      convType: "dm",
      selfId: "me",
      agentEnabled: false,
    });
    await svc.onImMessage({
      id: "m5",
      conversationId: "conv-1",
      senderId: "peer",
      content: "在吗",
      createdAt: "t",
    });
    expect(appended).toEqual([]);
    expect(kicked).toEqual([]);
  });
  it("无账号上下文：直接返回", async () => {
    const { svc, appended } = makeSvc({ convType: "dm", selfId: "me" });
    (svc as any).account.get = () => null;
    await svc.onImMessage({
      id: "m6",
      conversationId: "conv-1",
      senderId: "peer",
      content: "x",
      createdAt: "t",
    });
    expect(appended).toEqual([]);
  });
  it("处理异常被吞掉（不抛出未处理 rejection）", async () => {
    const { svc, sessions } = makeSvc({ convType: "dm", selfId: "me" });
    sessions.findOrCreateImCompanion = jest
      .fn()
      .mockRejectedValue(new Error("boom"));
    await expect(
      svc.onImMessage({
        id: "m7",
        conversationId: "conv-1",
        senderId: "peer",
        content: "x",
        createdAt: "t",
      }),
    ).resolves.toBeUndefined();
  });
});
