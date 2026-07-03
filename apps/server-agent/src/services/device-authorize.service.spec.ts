import { EventEmitter2 } from "@nestjs/event-emitter";
import { DeviceAuthorizeService } from "./device-authorize.service";

function build() {
  const cloud = {
    post: jest.fn(async (path: string, _body?: unknown) => {
      if (path === "/api/device-auth/start")
        return {
          requestId: "r1",
          verifyUrl: "http://cloud/authorize?request=r1",
        };
      if (path === "/api/device-auth/exchange")
        return {
          deviceToken: "mbd_tok",
          user: { id: "u1", email: "a@x.io", displayName: "A" },
          orgId: "o1",
        };
      throw new Error(`unexpected ${path}`);
    }),
    get: jest.fn(async () => ({
      user: { id: "u1", email: "a@x.io", displayName: "A" },
      activeOrg: { id: "o1", name: "Org", role: "owner" },
      memberships: [],
    })),
  };
  const identity = { upsert: jest.fn(async () => undefined) };
  const runtime = { createRuntime: jest.fn(async () => undefined) };
  const jwt = { sign: jest.fn(() => "local-jwt") };
  const emitter = new EventEmitter2();
  const svc = new DeviceAuthorizeService(
    cloud as never,
    identity as never,
    runtime as never,
    jwt as never,
    emitter,
  );
  return { svc, cloud, identity, runtime, jwt, emitter };
}

describe("DeviceAuthorizeService", () => {
  it("start 发起云端请求并缓存 verifier", async () => {
    const { svc, cloud } = build();
    const r = await svc.start();
    expect(r).toEqual({
      requestId: "r1",
      authorizeUrl: "http://cloud/authorize?request=r1",
    });
    const body = cloud.post.mock.calls[0][1] as {
      codeChallenge: string;
      redirectUri: string;
    };
    expect(body.codeChallenge).toMatch(/^[0-9a-f]{64}$/);
    expect(body.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/callback$/,
    );
  });

  it("complete 兑换后写镜像、建运行时、签本地 JWT、发事件", async () => {
    const { svc, cloud, identity, runtime, jwt, emitter } = build();
    const events: unknown[] = [];
    emitter.on("auth.authorized", (p) => events.push(p));
    await svc.start();
    const r = await svc.complete("r1", "code-1");
    expect(r).toEqual({ access_token: "local-jwt" });
    const exchangeBody = cloud.post.mock.calls[1][1] as {
      codeVerifier: string;
      userCode: string;
    };
    expect(exchangeBody.userCode).toBe("code-1");
    expect(identity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudUserId: "u1",
        deviceToken: "mbd_tok",
        orgId: "o1",
      }),
    );
    expect(runtime.createRuntime).toHaveBeenCalledWith("u1");
    expect(jwt.sign).toHaveBeenCalledWith({ sub: "u1", email: "a@x.io" });
    expect(events).toEqual([{ cloudUserId: "u1" }]);
  });

  it("poll 在 complete 前 pending,后 done 且一次性", async () => {
    const { svc } = build();
    await svc.start();
    expect(await svc.poll("r1")).toEqual({ status: "pending" });
    await svc.complete("r1", "code-1");
    expect(await svc.poll("r1")).toEqual({
      status: "done",
      access_token: "local-jwt",
    });
    expect(await svc.poll("r1")).toEqual({ status: "pending" });
  });

  it("无 pending 时 complete 抛 AUTH_NO_PENDING_REQUEST", async () => {
    const { svc } = build();
    await expect(svc.complete("nope", "c")).rejects.toMatchObject({
      name: "AppError",
    });
  });

  it("completeByCode 用最新 pending", async () => {
    const { svc } = build();
    await svc.start();
    await expect(svc.completeByCode("code-1")).resolves.toEqual({
      access_token: "local-jwt",
    });
  });
});
