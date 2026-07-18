import { AccountContextService } from "@meshbot/lib-agent";
import { AUTH_WS_EVENTS, IM_WS_EVENTS } from "@meshbot/types";
import { SCHEDULE_EVENTS, SESSION_STATUS_EVENTS } from "@meshbot/types-agent";

import { EventsGateway } from "./events.gateway";

function makeGateway(
  account: AccountContextService,
  onlinePeers: string[] = [],
) {
  const imRelay = {
    getOnlinePeers: jest.fn().mockReturnValue(onlinePeers),
    setUiPresence: jest.fn(),
  };
  const gw = new EventsGateway({} as never, imRelay as never, account);
  const broadcastEmit = jest.fn();
  const roomEmit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit: roomEmit });
  (gw as unknown as { server: unknown }).server = { emit: broadcastEmit, to };
  return { gw, broadcastEmit, roomEmit, to, imRelay };
}

describe("EventsGateway 下行信封 + 账号路由", () => {
  const msg = { id: "m1", conversationId: "c1", senderId: "u2", content: "1" };

  it("有账号上下文 → 发 acct 房间的单一 event，载荷为信封", () => {
    const account = new AccountContextService();
    const { gw, broadcastEmit, roomEmit, to } = makeGateway(account);

    account.run("U1", () => gw.onMessage(msg as never));

    expect(to).toHaveBeenCalledWith("acct:U1");
    expect(roomEmit).toHaveBeenCalledTimes(1);
    const [eventName, env] = roomEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(IM_WS_EVENTS.message);
    expect(env.payload).toEqual(msg);
    expect(typeof env.ts).toBe("number");
    expect(broadcastEmit).not.toHaveBeenCalled();
  });

  it("im.conversation_read 也走信封", () => {
    const account = new AccountContextService();
    const { gw, roomEmit } = makeGateway(account);
    const payload = {
      conversationId: "c1",
      lastReadAt: "2026-06-20T00:00:00.000Z",
    };
    account.run("U1", () => gw.onConversationRead(payload as never));
    const [eventName, env] = roomEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(IM_WS_EVENTS.conversationRead);
    expect(env.payload).toEqual(payload);
  });

  it("无账号上下文 → 降级全量广播单一 event", () => {
    const account = new AccountContextService();
    const { gw, broadcastEmit, to } = makeGateway(account);
    gw.onMessage(msg as never);
    expect(to).not.toHaveBeenCalled();
    const [eventName, env] = broadcastEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(IM_WS_EVENTS.message);
  });

  it("handleConnection：未鉴权 socket 不入房间", () => {
    const account = new AccountContextService();
    const { gw } = makeGateway(account);
    const join = jest.fn();
    gw.handleConnection({ data: {}, join, once: jest.fn() } as never);
    expect(join).not.toHaveBeenCalled();
  });

  it("handleConnection：已鉴权 socket 加入 acct:<sub>", () => {
    const account = new AccountContextService();
    const { gw } = makeGateway(account);
    const join = jest.fn();
    gw.handleConnection({
      data: { user: { sub: "U1" } },
      join,
      once: jest.fn(),
    } as never);
    expect(join).toHaveBeenCalledWith("acct:U1");
  });

  it("handleConnection：回放在线快照给新浏览器 socket", () => {
    const account = new AccountContextService();
    const { gw, imRelay } = makeGateway(account, ["peerA", "peerB"]);
    const emit = jest.fn();
    gw.handleConnection({
      data: { user: { sub: "U1" } },
      join: jest.fn(),
      once: jest.fn(),
      emit,
    } as never);
    expect(imRelay.getOnlinePeers).toHaveBeenCalledWith("U1");
    expect(emit).toHaveBeenCalledTimes(2);
    const [eventName, env] = emit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(IM_WS_EVENTS.presence);
    expect(env.payload).toEqual({ userId: "peerA", online: true });
  });

  it("schedule.fired 本地事件包信封下发", () => {
    const account = new AccountContextService();
    const { gw, roomEmit } = makeGateway(account);
    const payload = { sessionId: "s1", jobId: "j1", title: "t" };
    account.run("U1", () => gw.onScheduleFired(payload as never));
    const [eventName, env] = roomEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(SCHEDULE_EVENTS.fired);
    expect(env.payload).toEqual(payload);
  });

  it("session.status_changed 本地事件包信封下发到 acct 房间", () => {
    const account = new AccountContextService();
    const { gw, roomEmit, to } = makeGateway(account);
    const payload = { sessionId: "s1", status: "idle" as const };
    account.run("U1", () => gw.onSessionStatusChanged(payload));
    expect(to).toHaveBeenCalledWith("acct:U1");
    const [eventName, env] = roomEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(SESSION_STATUS_EVENTS.changed);
    expect(env.payload).toEqual(payload);
  });

  it("auth.reauth_required 本地事件 → 信封转发为 AUTH_WS_EVENTS.reauthRequired", () => {
    const account = new AccountContextService();
    const { gw, roomEmit, to } = makeGateway(account);
    const payload = { cloudUserId: "U1" };
    account.run("U1", () => gw.onReauthRequired(payload));
    expect(to).toHaveBeenCalledWith("acct:U1");
    const [eventName, env] = roomEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(AUTH_WS_EVENTS.reauthRequired);
    expect(env.payload).toEqual(payload);
  });
});

describe("EventsGateway 浏览器连接数驱动在线状态", () => {
  function makeClient(sub: string | undefined) {
    return {
      data: sub ? { user: { sub } } : {},
      join: jest.fn(),
      once: jest.fn(),
      emit: jest.fn(),
    };
  }

  it("首个浏览器 handleConnection → setUiPresence(sub, true) 调一次", () => {
    const account = new AccountContextService();
    const { gw, imRelay } = makeGateway(account);
    gw.handleConnection(makeClient("U1") as never);
    expect(imRelay.setUiPresence).toHaveBeenCalledTimes(1);
    expect(imRelay.setUiPresence).toHaveBeenCalledWith("U1", true);
  });

  it("同账号第二个 handleConnection → setUiPresence(true) 不再调", () => {
    const account = new AccountContextService();
    const { gw, imRelay } = makeGateway(account);
    gw.handleConnection(makeClient("U1") as never);
    gw.handleConnection(makeClient("U1") as never);
    // setUiPresence(true) 只在 0→1 时触发，第二次不触发
    const trueCalls = (imRelay.setUiPresence as jest.Mock).mock.calls.filter(
      ([, online]) => online === true,
    );
    expect(trueCalls).toHaveLength(1);
  });

  it("未鉴权 handleConnection → 不调 setUiPresence", () => {
    const account = new AccountContextService();
    const { gw, imRelay } = makeGateway(account);
    gw.handleConnection(makeClient(undefined) as never);
    expect(imRelay.setUiPresence).not.toHaveBeenCalled();
  });

  it("最后一个浏览器 handleDisconnect → setUiPresence(sub, false)", () => {
    const account = new AccountContextService();
    const { gw, imRelay } = makeGateway(account);
    const c1 = makeClient("U1");
    gw.handleConnection(c1 as never);
    (imRelay.setUiPresence as jest.Mock).mockClear();

    gw.handleDisconnect(c1 as never);
    expect(imRelay.setUiPresence).toHaveBeenCalledWith("U1", false);
  });

  it("多窗口：先 connect 两次再 disconnect 一次 → 不调 setUiPresence(false)", () => {
    const account = new AccountContextService();
    const { gw, imRelay } = makeGateway(account);
    gw.handleConnection(makeClient("U1") as never);
    gw.handleConnection(makeClient("U1") as never);
    (imRelay.setUiPresence as jest.Mock).mockClear();

    gw.handleDisconnect(makeClient("U1") as never);
    expect(imRelay.setUiPresence).not.toHaveBeenCalledWith("U1", false);
  });

  it("未鉴权 handleDisconnect → 不调 setUiPresence", () => {
    const account = new AccountContextService();
    const { gw, imRelay } = makeGateway(account);
    gw.handleDisconnect(makeClient(undefined) as never);
    expect(imRelay.setUiPresence).not.toHaveBeenCalled();
  });
});
