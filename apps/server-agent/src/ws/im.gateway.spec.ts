import { AccountContextService } from "@meshbot/agent";
import { IM_WS_EVENTS } from "@meshbot/types";

import { ImGateway } from "./im.gateway";

/**
 * ImGateway 下行账号路由单测。
 * 关键不变量：relay 经 account.run(cloudUserId) 同步触发 @OnEvent，故下行只投递给
 * 该账号的 acct:<id> 房间（多账号同时在线不重复、不跨账号泄漏）；无上下文降级全量广播。
 */
function makeGateway(account: AccountContextService) {
  const gw = new ImGateway(
    {} as never, // jwt（本测不用）
    {} as never, // imRelay（本测不用）
    account,
  );
  const broadcastEmit = jest.fn();
  const roomEmit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit: roomEmit });
  (gw as unknown as { server: unknown }).server = { emit: broadcastEmit, to };
  return { gw, broadcastEmit, roomEmit, to };
}

describe("ImGateway 下行账号路由", () => {
  const msg = { id: "m1", conversationId: "c1", senderId: "u2", content: "1" };

  it("有账号上下文 → 只发 acct:<id> 房间，不全量广播", () => {
    const account = new AccountContextService();
    const { gw, broadcastEmit, roomEmit, to } = makeGateway(account);

    account.run("U1", () => gw.onMessage(msg as never));

    expect(to).toHaveBeenCalledWith("acct:U1");
    expect(roomEmit).toHaveBeenCalledWith(IM_WS_EVENTS.message, msg);
    expect(broadcastEmit).not.toHaveBeenCalled();
  });

  it("无账号上下文 → 降级全量广播（不丢消息）", () => {
    const account = new AccountContextService();
    const { gw, broadcastEmit, to } = makeGateway(account);

    gw.onMessage(msg as never);

    expect(broadcastEmit).toHaveBeenCalledWith(IM_WS_EVENTS.message, msg);
    expect(to).not.toHaveBeenCalled();
  });

  it("handleConnection：已鉴权 socket 加入 acct:<sub> 房间", () => {
    const account = new AccountContextService();
    const { gw } = makeGateway(account);
    const join = jest.fn();
    const client = {
      data: { user: { sub: "U1" } },
      join,
      once: jest.fn(),
    };

    gw.handleConnection(client as never);

    expect(join).toHaveBeenCalledWith("acct:U1");
  });

  it("handleConnection：未鉴权 socket 不入房间", () => {
    const account = new AccountContextService();
    const { gw } = makeGateway(account);
    const join = jest.fn();
    const client = { data: {}, join, once: jest.fn() };

    gw.handleConnection(client as never);

    expect(join).not.toHaveBeenCalled();
  });
});
