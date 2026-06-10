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

    const svc = new CloudAuthService(
      cloud as never,
      identity as never,
      jwt as never,
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
      }),
    );
    expect(jwt.sign).toHaveBeenCalledWith({ sub: "u1", email: "a@x.io" });
    expect(out).toEqual({ access_token: "local-jwt" });
  });

  it("getProfile：无身份镜像抛 AUTH_UNAUTHORIZED", async () => {
    const svc = new CloudAuthService(
      {} as never,
      { get: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
    );
    await expect(svc.getProfile()).rejects.toMatchObject({
      name: "AppError",
    });
  });
});
