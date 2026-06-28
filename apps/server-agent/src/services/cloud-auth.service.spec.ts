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

/** switchOrg：代理云端 switch-org + 刷新镜像，不重建 runtime，不重签 JWT。 */
describe("CloudAuthService.switchOrg", () => {
  it("切换组织成功：调云端 switch-org + profile，upsert 新 cloudToken + 新 org，不调 createRuntime", async () => {
    const account = new AccountContextService();

    const cloud = {
      post: jest.fn().mockResolvedValue({
        token: "new-cloud-jwt",
        expiresIn: "7d",
        user: { id: "u1", email: "a@x.io", displayName: "Alice" },
      }),
      get: jest.fn().mockResolvedValue({
        user: { id: "u1", email: "a@x.io", displayName: "Alice" },
        activeOrg: { id: "org2", name: "Beta Corp", role: "member" },
        memberships: [{ id: "org2", name: "Beta Corp", role: "member" }],
      }),
    };
    const identity = {
      get: jest.fn().mockResolvedValue({
        cloudUserId: "u1",
        email: "a@x.io",
        displayName: "Alice",
        cloudToken: "old-cloud-jwt",
        orgId: "org1",
        orgName: "Acme",
        role: "owner",
      }),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = makeRuntime();

    const svc = new CloudAuthService(
      cloud as never,
      identity as never,
      {} as never,
      account,
      runtime as never,
    );

    // getProfile 内部也调 identity.get，追加一次返回新 org 的结果
    identity.get
      .mockResolvedValueOnce({
        cloudUserId: "u1",
        email: "a@x.io",
        displayName: "Alice",
        cloudToken: "old-cloud-jwt",
        orgId: "org1",
        orgName: "Acme",
        role: "owner",
      })
      .mockResolvedValueOnce({
        cloudUserId: "u1",
        email: "a@x.io",
        displayName: "Alice",
        cloudToken: "new-cloud-jwt",
        orgId: "org2",
        orgName: "Beta Corp",
        role: "member",
      });

    const result = await account.run("u1", () => svc.switchOrg("org2"));

    // 调云端 switch-org（携带旧 cloudToken）
    expect(cloud.post).toHaveBeenCalledWith(
      "/api/auth/switch-org",
      { orgId: "org2" },
      "old-cloud-jwt",
    );
    // 用新 token 拉 profile
    expect(cloud.get).toHaveBeenCalledWith(
      "/api/auth/profile",
      "new-cloud-jwt",
    );
    // upsert 含新 cloudToken + 新 org 信息
    expect(identity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudUserId: "u1",
        cloudToken: "new-cloud-jwt",
        orgId: "org2",
        orgName: "Beta Corp",
        role: "member",
        cloudTokenExpiresAt: expect.stringMatching(/T/),
      }),
    );
    // 不重建 runtime
    expect(runtime.createRuntime).not.toHaveBeenCalled();
    // 返回的 profile 反映新组织
    expect(result.org).toEqual({
      id: "org2",
      name: "Beta Corp",
      role: "member",
    });
  });

  it("无 cloudToken 时抛 AUTH_UNAUTHORIZED", async () => {
    const account = new AccountContextService();
    const identity = {
      get: jest.fn().mockResolvedValue({ cloudUserId: "u1", cloudToken: null }),
    };
    const svc = new CloudAuthService(
      {} as never,
      identity as never,
      {} as never,
      account,
      makeRuntime() as never,
    );

    await expect(
      account.run("u1", () => svc.switchOrg("org2")),
    ).rejects.toMatchObject({ name: "AppError" });
  });
});
