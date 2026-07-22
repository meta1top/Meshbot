import { AccountContextService } from "@meshbot/lib-agent";
import type { JwtService } from "@nestjs/jwt";
import { SetupController } from "./setup.controller";
import type { CloudAuthService } from "../services/cloud-auth.service";
import type { CloudIdentityService } from "../services/cloud-identity.service";
import type { CloudIdentity } from "../entities/cloud-identity.entity";
import type { ModelConfigService } from "../services/model-config.service";

type StubIdentityService = jest.Mocked<
  Pick<CloudIdentityService, "listLoggedIn" | "get">
>;
type StubCloudAuthService = jest.Mocked<
  Pick<CloudAuthService, "trySyncActiveOrg">
>;
type StubModelConfigService = jest.Mocked<
  Pick<ModelConfigService, "hasEnabledModels">
>;
// JwtService.verify 是泛型方法（<T>(token, options?) => T），具体 mock 实现
// 无法真正满足任意 T 的泛型签名，故不走 Pick<JwtService,...> 精确匹配，
// 只声明实际用到的具体签名，构造处再经 unknown 桥接到 JwtService。
type StubJwtService = { verify: jest.Mock<{ sub?: string }, [string]> };

/**
 * 回归测试：Public 路由 GET /api/setup-status 在无 ALS 账号上下文时，
 * 对已登录账号分支（needs-model / ready）不得抛 NO_ACCOUNT_CONTEXT。
 */
describe("SetupController.getSetupStatus（Public 路由，无环境上下文）", () => {
  const makeController = (opts: {
    loggedIn: Array<{
      cloudUserId: string;
      deviceToken: string;
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
    const identityService: StubIdentityService = {
      listLoggedIn: jest
        .fn()
        .mockResolvedValue(opts.loggedIn as unknown as CloudIdentity[]),
      get: jest.fn((uid: string) =>
        Promise.resolve(
          (byId[uid] as unknown as CloudIdentity | undefined) ?? null,
        ),
      ),
    };

    const cloudAuthService: StubCloudAuthService = {
      trySyncActiveOrg: jest.fn().mockResolvedValue(undefined),
    };

    const modelConfigService: StubModelConfigService = {
      hasEnabledModels: jest.fn().mockResolvedValue(opts.hasEnabledModels),
    };

    const jwtService: StubJwtService = {
      verify: jest.fn((_token: string) => {
        if (opts.tokenUserId == null) throw new Error("invalid token");
        return { sub: opts.tokenUserId };
      }),
    };

    const controller = new SetupController(
      modelConfigService as unknown as ModelConfigService,
      identityService as unknown as CloudIdentityService,
      cloudAuthService as unknown as CloudAuthService,
      ctx,
      jwtService as unknown as JwtService,
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
      loggedIn: [{ cloudUserId: "u1", deviceToken: "tok", orgId: "org1" }],
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
      loggedIn: [{ cloudUserId: "u1", deviceToken: "tok", orgId: "org1" }],
      hasEnabledModels: true,
    });

    await expect(controller.getSetupStatus()).resolves.toEqual({
      step: "ready",
      needsSetup: false,
    });
  });

  it("无 orgId：已登录但无 orgId → 自愈同步后仍按 hasEnabledModels 判定（不再有 needs-org 分流）", async () => {
    const { controller, modelConfigService, identityService } = makeController({
      loggedIn: [{ cloudUserId: "u1", deviceToken: "tok", orgId: null }],
      hasEnabledModels: false,
    });

    const result = await controller.getSetupStatus();

    expect(result).toEqual({ step: "needs-model", needsSetup: true });
    expect(identityService.get).toHaveBeenCalledWith("u1");
    expect(modelConfigService.hasEnabledModels).toHaveBeenCalled();
  });

  it("多账号：按 token 解出的活跃账号判定，而非 listLoggedIn()[0]", async () => {
    // A 已 ready（listLoggedIn 首位），B 无 org 且无模型。带 B 的 token → 应返回 B 的
    // needs-model，而不是 A 的 ready —— 这正是「按活跃账号而非首位判定」的修复点。
    const { controller, identityService } = makeController({
      loggedIn: [
        { cloudUserId: "A", deviceToken: "tokA", orgId: "orgA" },
        { cloudUserId: "B", deviceToken: "tokB", orgId: null },
      ],
      hasEnabledModels: false,
      tokenUserId: "B",
    });

    const result = await controller.getSetupStatus("Bearer tokenB");

    expect(result).toEqual({ step: "needs-model", needsSetup: true });
    expect(identityService.listLoggedIn).not.toHaveBeenCalled();
  });

  it("token 无效 → 回退第一个已登录账号", async () => {
    const { controller, identityService } = makeController({
      loggedIn: [{ cloudUserId: "A", deviceToken: "tokA", orgId: "orgA" }],
      hasEnabledModels: true,
      tokenUserId: null, // verify 抛错
    });

    const result = await controller.getSetupStatus("Bearer garbage");

    expect(result).toEqual({ step: "ready", needsSetup: false });
    expect(identityService.listLoggedIn).toHaveBeenCalled();
  });
});
