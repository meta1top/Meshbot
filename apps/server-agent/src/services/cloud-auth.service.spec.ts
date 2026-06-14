import { CloudAuthService } from "./cloud-auth.service";

/** 用桩验证：登录调云端 login + profile，upsert 镜像，签本地 JWT。 */
describe("CloudAuthService.login", () => {
  it("登录成功：调云端、写镜像、返回本地 access_token", async () => {
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

    const imRelay = { connect: jest.fn().mockResolvedValue(undefined) };
    const svc = new CloudAuthService(
      cloud as never,
      identity as never,
      jwt as never,
      imRelay as never,
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
    expect(jwt.sign).toHaveBeenCalledWith({ sub: "u1", email: "a@x.io" });
    expect(out).toEqual({ access_token: "local-jwt" });
    expect(imRelay.connect).toHaveBeenCalledTimes(1);
  });

  it("getProfile：无身份镜像抛 AUTH_UNAUTHORIZED", async () => {
    const svc = new CloudAuthService(
      {} as never,
      { get: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      { connect: jest.fn(), disconnect: jest.fn() } as never,
    );
    await expect(svc.getProfile()).rejects.toMatchObject({
      name: "AppError",
    });
  });

  it("register 成功：调云端、写镜像、返回本地 access_token，并触发 IM relay connect", async () => {
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
    const imRelay = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };

    const svc = new CloudAuthService(
      cloud as never,
      identity as never,
      jwt as never,
      imRelay as never,
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
    expect(imRelay.connect).toHaveBeenCalledTimes(1);
  });
});
