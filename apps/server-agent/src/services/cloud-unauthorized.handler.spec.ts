import { AccountContextService } from "@meshbot/lib-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { AUTH_EVENTS } from "./auth.events";
import { buildUnauthorizedHandler } from "./cloud-unauthorized.handler";

/**
 * auth.module 里 CloudClientService 的 setUnauthorizedHandler 逻辑单测。
 * 该 handler 依赖「同步执行不掉出 ALS 上下文」的隐式假设——EventsGateway 的
 * emitEnvelope 靠 ALS 里的账号路由到 acct 房间，本 spec 固化这条链路。
 */
describe("buildUnauthorizedHandler（云端 401 → setLoggedOut + reauthRequired）", () => {
  function build() {
    const account = new AccountContextService();
    const identity = {
      setLoggedOut: jest.fn().mockResolvedValue(undefined),
    };
    const emitter = new EventEmitter2();
    const emitSpy = jest.spyOn(emitter, "emit");
    const handler = buildUnauthorizedHandler(
      account,
      identity as never,
      emitter,
    );
    return { account, identity, emitter, emitSpy, handler };
  }

  it("账号上下文内触发 → setLoggedOut(该账号) + emit reauthRequired（cloudUserId 正确）", () => {
    const { account, identity, emitSpy, handler } = build();

    account.run("u1", () => handler());

    expect(identity.setLoggedOut).toHaveBeenCalledTimes(1);
    expect(identity.setLoggedOut).toHaveBeenCalledWith("u1");
    expect(emitSpy).toHaveBeenCalledWith(AUTH_EVENTS.reauthRequired, {
      cloudUserId: "u1",
    });
  });

  it("emit 发生在账号 ALS 上下文内（EventsGateway 房间路由依赖此不变量）", () => {
    const { account, emitter, handler } = build();
    let ctxAtEmit: string | null | undefined;
    emitter.on(AUTH_EVENTS.reauthRequired, () => {
      ctxAtEmit = account.get();
    });

    account.run("u1", () => handler());

    expect(ctxAtEmit).toBe("u1");
  });

  it("无账号上下文（后台路径）→ 不 setLoggedOut、不 emit、不抛", () => {
    const { identity, emitSpy, handler } = build();

    expect(() => handler()).not.toThrow();

    expect(identity.setLoggedOut).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalledWith(
      AUTH_EVENTS.reauthRequired,
      expect.anything(),
    );
  });
});
