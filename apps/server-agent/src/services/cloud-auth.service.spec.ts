import { AccountContextService } from "@meshbot/agent";
import { CloudAuthService } from "./cloud-auth.service";

const makeRuntime = () => ({
  createRuntime: jest.fn().mockResolvedValue(undefined),
  teardownRuntime: jest.fn().mockResolvedValue(undefined),
  has: jest.fn().mockReturnValue(false),
});

/** 用桩验证：登录调云端 login + profile，upsert 镜像，建运行时，签本地 JWT。 */
describe("CloudAuthService.login", () => {
  it("登录成功：调云端、写镜像、建运行时、返回本地 access_token", async () => {
    const cloud = {
      post: jest.fn().mockResolvedValue({
        token: "cloud-jwt",
        expiresIn: "7d",
        user: { id: "u1", email: "a@x.io", displayName: "Alice" },
      }),
      get: jest.fn().mockResolvedValue({
        user: { id: "u1", email: "a@x.io", displayName: "Alice" },
        activeOrg: { id: "o1", name: "Acme", role: "owner" },
        memberships: [{ id: "o1", name: "Acme", role: "owner" }],
      }),
    };
    const identity = { upsert: jest.fn().mockResolvedValue(undefined) };
    const jwt = { sign: jest.fn().mockReturnValue("local-jwt") };
    const runtime = makeRuntime();

    const svc = new CloudAuthService(
      cloud as never,
      identity as never,
      jwt as never,
      new AccountContextService(),
      runtime as never,
    );
    const out = await svc.login({ email: "a@x.io", password: "p" });

    expect(cloud.post).toHaveBeenCalledWith("/api/auth/login", {
      email: "a@x.io",
      password: "p",
    });
    expect(cloud.get).toHaveBeenCalledWith("/api/auth/profile", "cloud-jwt");
    expect(identity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudUserId: "u1",
        orgId: "o1",
        orgName: "Acme",
        cloudToken: "cloud-jwt",
        // expiresIn "7d" 应换算为 ISO 过期时间（而非 null）
        cloudTokenExpiresAt: expect.stringMatching(/T/),
      }),
    );
    expect(runtime.createRuntime).toHaveBeenCalledWith("u1");
    expect(jwt.sign).toHaveBeenCalledWith({ sub: "u1", email: "a@x.io" });
    expect(out).toEqual({ access_token: "local-jwt" });
  });

  it("getProfile：无身份镜像抛 AUTH_UNAUTHORIZED", async () => {
    const account = new AccountContextService();
    const identity = { get: jest.fn().mockResolvedValue(null) };
    const svc = new CloudAuthService(
      {} as never,
      identity as never,
      {} as never,
      account,
      makeRuntime() as never,
    );
    // getProfile 现在按当前账号读镜像；在账号上下文内调用
    await expect(
      account.run("u1", () => svc.getProfile()),
    ).rejects.toMatchObject({
      name: "AppError",
    });
    expect(identity.get).toHaveBeenCalledWith("u1");
  });

  it("register 成功：调云端、写镜像、建运行时、返回本地 access_token", async () => {
    const cloud = {
      post: jest.fn().mockResolvedValue({
        token: "cloud-jwt-reg",
        expiresIn: "7d",
        user: { id: "u2", email: "b@x.io", displayName: "Bob" },
      }),
      get: jest.fn().mockResolvedValue({
        user: { id: "u2", email: "b@x.io", displayName: "Bob" },
        activeOrg: null,
        memberships: [],
      }),
    };
    const identity = { upsert: jest.fn().mockResolvedValue(undefined) };
    const jwt = { sign: jest.fn().mockReturnValue("local-jwt-reg") };
    const runtime = makeRuntime();

    const svc = new CloudAuthService(
      cloud as never,
      identity as never,
      jwt as never,
      new AccountContextService(),
      runtime as never,
    );
    const out = await svc.register({
      email: "b@x.io",
      password: "p",
      displayName: "Bob",
    });

    expect(cloud.post).toHaveBeenCalledWith("/api/auth/register", {
      email: "b@x.io",
      password: "p",
      displayName: "Bob",
    });
    expect(out).toEqual({ access_token: "local-jwt-reg" });
    expect(runtime.createRuntime).toHaveBeenCalledWith("u2");
  });

  it("logout：调 runtime.teardownRuntime 再置 loggedIn=false，不直接调 relay", async () => {
    const account = new AccountContextService();
    const identity = { setLoggedOut: jest.fn().mockResolvedValue(undefined) };
    const runtime = makeRuntime();

    const svc = new CloudAuthService(
      {} as never,
      identity as never,
      {} as never,
      account,
      runtime as never,
    );

    await account.run("u1", () => svc.logout());

    expect(runtime.teardownRuntime).toHaveBeenCalledWith("u1");
    expect(identity.setLoggedOut).toHaveBeenCalledWith("u1");
  });
});
