import { AccountContextService } from "@meshbot/agent";
import { IM_WS_EVENTS } from "@meshbot/types";
import { SCHEDULE_EVENTS } from "@meshbot/types-agent";

import { EventsGateway } from "./events.gateway";

function makeGateway(account: AccountContextService) {
  const gw = new EventsGateway({} as never, {} as never, account);
  const broadcastEmit = jest.fn();
  const roomEmit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit: roomEmit });
  (gw as unknown as { server: unknown }).server = { emit: broadcastEmit, to };
  return { gw, broadcastEmit, roomEmit, to };
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
});
