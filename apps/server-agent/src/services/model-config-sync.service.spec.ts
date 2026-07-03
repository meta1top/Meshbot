import { AccountContextService } from "@meshbot/agent";
import type { AgentModelConfig } from "@meshbot/types";

import { ModelConfigSyncService } from "./model-config-sync.service";

/** 造 2 条云端下发的模型配置样例数据。 */
function sampleConfigs(): AgentModelConfig[] {
  return [
    {
      id: "cfg-1",
      providerType: "openai",
      name: "GPT-4o",
      model: "gpt-4o",
      apiKey: "sk-1",
      baseUrl: "",
      contextWindow: 128_000,
      enabled: true,
    },
    {
      id: "cfg-2",
      providerType: "deepseek",
      name: "DS Chat",
      model: "deepseek-chat",
      apiKey: "sk-2",
      baseUrl: "",
      contextWindow: 64_000,
      enabled: true,
    },
  ];
}

describe("ModelConfigSyncService", () => {
  function build() {
    const account = new AccountContextService();
    const cloud = {
      get: jest.fn(),
    };
    const identity = {
      get: jest.fn(),
      listLoggedIn: jest.fn(),
    };
    const modelConfig = {
      replaceCloudConfigs: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModelConfigSyncService(
      cloud as never,
      identity as never,
      account,
      modelConfig as never,
    );
    return { account, cloud, identity, modelConfig, service };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("syncNow：deviceToken 调云端接口，replaceCloudConfigs 收到全部配置且在该账号上下文内", async () => {
    const { cloud, identity, modelConfig, service, account } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue(sampleConfigs());
    let ctxDuringReplace: string | null = null;
    modelConfig.replaceCloudConfigs.mockImplementation(async () => {
      ctxDuringReplace = account.get();
    });

    const ok = await service.syncNow("u1");

    expect(ok).toBe(true);
    expect(cloud.get).toHaveBeenCalledWith("/api/agent/model-configs", "mbd_x");
    expect(modelConfig.replaceCloudConfigs).toHaveBeenCalledWith(
      sampleConfigs(),
    );
    expect(ctxDuringReplace).toBe("u1");
  });

  it("cloud.get 抛错 → syncNow 返回 false 且不 throw", async () => {
    const { cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockRejectedValue(new Error("network down"));

    await expect(service.syncNow("u1")).resolves.toBe(false);
  });

  it("identity.get 无 deviceToken → 直接返回 false，不打网络", async () => {
    const { cloud, identity, modelConfig, service } = build();
    identity.get.mockResolvedValue({ deviceToken: null });

    const ok = await service.syncNow("u1");

    expect(ok).toBe(false);
    expect(cloud.get).not.toHaveBeenCalled();
    expect(modelConfig.replaceCloudConfigs).not.toHaveBeenCalled();
  });

  describe("失败退避（按账号独立计数）", () => {
    const MINUTE = 60 * 1000;
    const INTERVAL = 30 * MINUTE;

    /** 访问私有 nextDelay（退避计算抽出的可测方法）。 */
    function nextDelay(
      service: ModelConfigSyncService,
      identityCount: number,
      roundOk: boolean,
    ): number {
      return (
        service as unknown as {
          nextDelay(identityCount: number, roundOk: boolean): number;
        }
      ).nextDelay(identityCount, roundOk);
    }

    /** 让指定账号的 syncNow 失败一次（identity 有 token，cloud.get 抛错）。 */
    async function failOnce(
      service: ModelConfigSyncService,
      identity: { get: jest.Mock },
      cloud: { get: jest.Mock },
      cloudUserId: string,
    ): Promise<void> {
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      cloud.get.mockRejectedValue(new Error("boom"));
      await expect(service.syncNow(cloudUserId)).resolves.toBe(false);
    }

    /** 让指定账号的 syncNow 成功一次。 */
    async function succeedOnce(
      service: ModelConfigSyncService,
      identity: { get: jest.Mock },
      cloud: { get: jest.Mock },
      cloudUserId: string,
    ): Promise<void> {
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      cloud.get.mockResolvedValue(sampleConfigs());
      await expect(service.syncNow(cloudUserId)).resolves.toBe(true);
    }

    it("单账号连续失败 3 轮 → 退避 1 → 2 → 4 分钟递增", async () => {
      const { cloud, identity, service } = build();

      await failOnce(service, identity, cloud, "u1");
      expect(nextDelay(service, 1, false)).toBe(1 * MINUTE);

      await failOnce(service, identity, cloud, "u1");
      expect(nextDelay(service, 1, false)).toBe(2 * MINUTE);

      await failOnce(service, identity, cloud, "u1");
      expect(nextDelay(service, 1, false)).toBe(4 * MINUTE);
    });

    it("退避封顶 30 分钟（连败 6+ 轮不再翻倍）", async () => {
      const { cloud, identity, service } = build();

      for (let i = 0; i < 7; i += 1) {
        await failOnce(service, identity, cloud, "u1");
      }
      expect(nextDelay(service, 1, false)).toBe(INTERVAL);
    });

    it("u1 成功不影响 u2 的失败计数（按账号隔离）", async () => {
      const { cloud, identity, service } = build();

      await failOnce(service, identity, cloud, "u2");
      await failOnce(service, identity, cloud, "u2");
      await succeedOnce(service, identity, cloud, "u1");

      // u2 已连败 2 次，u1 的成功不得把退避拉回首败档位
      expect(nextDelay(service, 2, false)).toBe(2 * MINUTE);
    });

    it("u2 成功后其失败计数清零，再失败从 1 分钟重新起步", async () => {
      const { cloud, identity, service } = build();

      await failOnce(service, identity, cloud, "u2");
      await failOnce(service, identity, cloud, "u2");
      await succeedOnce(service, identity, cloud, "u2");

      expect(nextDelay(service, 1, true)).toBe(INTERVAL);

      await failOnce(service, identity, cloud, "u2");
      expect(nextDelay(service, 1, false)).toBe(1 * MINUTE);
    });

    it("无已登录账号 → 正常 30 分钟间隔（不算失败路径）", () => {
      const { service } = build();

      expect(nextDelay(service, 0, false)).toBe(INTERVAL);
    });

    it("本轮全部成功 → 正常 30 分钟间隔", async () => {
      const { cloud, identity, service } = build();

      await succeedOnce(service, identity, cloud, "u1");
      expect(nextDelay(service, 1, true)).toBe(INTERVAL);
    });

    it("账号 teardown 后其失败计数清零，不再影响下轮延迟计算", async () => {
      const { cloud, identity, service } = build();

      // u2 连续失败 2 次，延迟升到 2 分钟档位
      await failOnce(service, identity, cloud, "u2");
      await failOnce(service, identity, cloud, "u2");
      expect(nextDelay(service, 1, false)).toBe(2 * MINUTE);

      // u2 teardown（登出）清理其失败计数
      service.onRuntimeTeardown({ cloudUserId: "u2" });

      // failCounts 已空 → Math.max(1, ...[]) = 1 → 退避回落到首败 1 分钟档位
      expect(nextDelay(service, 1, false)).toBe(1 * MINUTE);
    });
  });
});
