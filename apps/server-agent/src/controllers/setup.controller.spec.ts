import { AccountContextService } from "@meshbot/agent";
import { SetupController } from "./setup.controller";

/**
 * 回归测试：Public 路由 GET /api/setup-status 在无 ALS 账号上下文时，
 * 对已登录账号分支（needs-model / ready）不得抛 NO_ACCOUNT_CONTEXT。
 */
describe("SetupController.getSetupStatus（Public 路由，无环境上下文）", () => {
  const makeController = (opts: {
    loggedIn: Array<{
      cloudUserId: string;
      cloudToken: string;
      orgId: string | null;
    }>;
    hasEnabledModels: boolean;
    /** jwt.verify 解出的 sub；undefined=无 token，null=token 无效（verify 抛错）。 */
    tokenUserId?: string | null;
  }) => {
    const ctx = new AccountContextService(); // 真实 ALS，无活跃上下文

    const byId = Object.fromEntries(
      opts.loggedIn.map((i) => [i.cloudUserId, i]),
    );
    const identityService: any = {
      listLoggedIn: jest.fn().mockResolvedValue(opts.loggedIn),
      get: jest.fn((uid: string) => Promise.resolve(byId[uid] ?? null)),
    };

    const cloudAuthService: any = {
      trySyncActiveOrg: jest.fn().mockResolvedValue(undefined),
    };

    const modelConfigService: any = {
      hasEnabledModels: jest.fn().mockResolvedValue(opts.hasEnabledModels),
    };

    const jwtService: any = {
      verify: jest.fn(() => {
        if (opts.tokenUserId == null) throw new Error("invalid token");
        return { sub: opts.tokenUserId };
      }),
    };

    const controller = new SetupController(
      modelConfigService,
      identityService,
      cloudAuthService,
      ctx,
      jwtService,
    );

    return { controller, modelConfigService, identityService };
  };

  it("needs-login：无已登录账号 → 返回 needs-login，不调用 hasEnabledModels", async () => {
    const { controller, modelConfigService } = makeController({
      loggedIn: [],
      hasEnabledModels: false,
    });

    const result = await controller.getSetupStatus();

    expect(result).toEqual({ step: "needs-login", needsSetup: true });
    expect(modelConfigService.hasEnabledModels).not.toHaveBeenCalled();
  });

  it("needs-model：已登录 + 有 org，但无启用模型 → 返回 needs-model，不抛 NO_ACCOUNT_CONTEXT", async () => {
    const { controller } = makeController({
      loggedIn: [{ cloudUserId: "u1", cloudToken: "tok", orgId: "org1" }],
      hasEnabledModels: false,
    });

    // 关键：no ctx.run() wrapping here — simulates the Public route where
    // AccountContextInterceptor never fires (no JWT → no ALS injection)
    await expect(controller.getSetupStatus()).resolves.toEqual({
      step: "needs-model",
      needsSetup: true,
    });
  });

  it("ready：已登录 + 有 org + 有启用模型 → 返回 ready，不抛 NO_ACCOUNT_CONTEXT", async () => {
    const { controller } = makeController({
      loggedIn: [{ cloudUserId: "u1", cloudToken: "tok", orgId: "org1" }],
      hasEnabledModels: true,
    });

    await expect(controller.getSetupStatus()).resolves.toEqual({
      step: "ready",
      needsSetup: false,
    });
  });

  it("needs-org：已登录但无 orgId → 返回 needs-org，不调用 hasEnabledModels", async () => {
    const { controller, modelConfigService } = makeController({
      loggedIn: [{ cloudUserId: "u1", cloudToken: "tok", orgId: null }],
      hasEnabledModels: false,
    });

    const result = await controller.getSetupStatus();

    expect(result).toEqual({ step: "needs-org", needsSetup: true });
    expect(modelConfigService.hasEnabledModels).not.toHaveBeenCalled();
  });

  it("多账号：按 token 解出的活跃账号判定，而非 listLoggedIn()[0]", async () => {
    // A 已 ready（listLoggedIn 首位），B 刚注册无 org。带 B 的 token → 应返回 B 的 needs-org，
    // 而不是 A 的 ready —— 这正是导致「注册成功后没进创建组织页」的判定错位修复点。
    const { controller, identityService } = makeController({
      loggedIn: [
        { cloudUserId: "A", cloudToken: "tokA", orgId: "orgA" },
        { cloudUserId: "B", cloudToken: "tokB", orgId: null },
      ],
      hasEnabledModels: true,
      tokenUserId: "B",
    });

    const result = await controller.getSetupStatus("Bearer tokenB");

    expect(result).toEqual({ step: "needs-org", needsSetup: true });
    expect(identityService.listLoggedIn).not.toHaveBeenCalled();
  });

  it("token 无效 → 回退第一个已登录账号", async () => {
    const { controller, identityService } = makeController({
      loggedIn: [{ cloudUserId: "A", cloudToken: "tokA", orgId: "orgA" }],
      hasEnabledModels: true,
      tokenUserId: null, // verify 抛错
    });

    const result = await controller.getSetupStatus("Bearer garbage");

    expect(result).toEqual({ step: "ready", needsSetup: false });
    expect(identityService.listLoggedIn).toHaveBeenCalled();
  });
});
