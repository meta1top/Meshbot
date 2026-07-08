import { AccountContextService } from "@meshbot/lib-agent";
import { CloudAuthService } from "./cloud-auth.service";

const makeRuntime = () => ({
  createRuntime: jest.fn().mockResolvedValue(undefined),
  teardownRuntime: jest.fn().mockResolvedValue(undefined),
  has: jest.fn().mockReturnValue(false),
});

describe("CloudAuthService.logout", () => {
  it("登出：调 runtime.teardownRuntime 再置 loggedIn=false，不直接调 relay", async () => {
    const account = new AccountContextService();
    const identity = { setLoggedOut: jest.fn().mockResolvedValue(undefined) };
    const runtime = makeRuntime();

    const svc = new CloudAuthService(
      {} as never,
      identity as never,
      account,
      runtime as never,
    );

    await account.run("u1", () => svc.logout());

    expect(runtime.teardownRuntime).toHaveBeenCalledWith("u1");
    expect(identity.setLoggedOut).toHaveBeenCalledWith("u1");
  });
});

describe("CloudAuthService.getProfile", () => {
  it("无身份镜像抛 AUTH_UNAUTHORIZED", async () => {
    const account = new AccountContextService();
    const identity = { get: jest.fn().mockResolvedValue(null) };
    const svc = new CloudAuthService(
      {} as never,
      identity as never,
      account,
      makeRuntime() as never,
    );
    await expect(
      account.run("u1", () => svc.getProfile()),
    ).rejects.toMatchObject({
      name: "AppError",
    });
    expect(identity.get).toHaveBeenCalledWith("u1");
  });
});

/** switchOrg：代理云端 devices/switch-org（设备 token）+ 刷新镜像，不重建 runtime。 */
describe("CloudAuthService.switchOrg", () => {
  it("切换组织成功：调云端 devices/switch-org + profile（均带 deviceToken），更新活跃组织镜像，不调 createRuntime", async () => {
    const account = new AccountContextService();

    const cloud = {
      post: jest.fn().mockResolvedValue({ ok: true }),
      get: jest.fn().mockResolvedValue({
        user: { id: "u1", email: "a@x.io", displayName: "Alice" },
        activeOrg: { id: "org2", name: "Beta Corp", role: "member" },
        memberships: [{ id: "org2", name: "Beta Corp", role: "member" }],
      }),
    };
    const identity = {
      get: jest.fn(),
      updateActiveOrg: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = makeRuntime();

    // switchOrg 内部读取一次拿 deviceToken，getProfile 内再读一次拿刷新后的镜像
    identity.get
      .mockResolvedValueOnce({
        cloudUserId: "u1",
        email: "a@x.io",
        displayName: "Alice",
        deviceToken: "mbd_tok",
        orgId: "org1",
        orgName: "Acme",
        role: "owner",
      })
      .mockResolvedValueOnce({
        cloudUserId: "u1",
        email: "a@x.io",
        displayName: "Alice",
        deviceToken: "mbd_tok",
        orgId: "org2",
        orgName: "Beta Corp",
        role: "member",
      });

    const svc = new CloudAuthService(
      cloud as never,
      identity as never,
      account,
      runtime as never,
    );

    const result = await account.run("u1", () => svc.switchOrg("org2"));

    // 调云端 devices/switch-org（携带设备 token）
    expect(cloud.post).toHaveBeenCalledWith(
      "/api/devices/switch-org",
      { orgId: "org2" },
      "mbd_tok",
    );
    // 用设备 token 拉 profile
    expect(cloud.get).toHaveBeenCalledWith("/api/auth/profile", "mbd_tok");
    // 更新活跃组织镜像
    expect(identity.updateActiveOrg).toHaveBeenCalledWith(
      "u1",
      "org2",
      "Beta Corp",
      "member",
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

  it("无 deviceToken 时抛 AUTH_UNAUTHORIZED", async () => {
    const account = new AccountContextService();
    const identity = {
      get: jest
        .fn()
        .mockResolvedValue({ cloudUserId: "u1", deviceToken: null }),
    };
    const svc = new CloudAuthService(
      {} as never,
      identity as never,
      account,
      makeRuntime() as never,
    );

    await expect(
      account.run("u1", () => svc.switchOrg("org2")),
    ).rejects.toMatchObject({ name: "AppError" });
  });
});
