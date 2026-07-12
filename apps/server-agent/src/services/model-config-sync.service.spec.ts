import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentModelConfig } from "@meshbot/types";

import { ModelConfigSyncService } from "./model-config-sync.service";
import type { CloudModelConfigRow } from "./model-config.service";

/** 测试用云端基址（config mock 固定返回，末尾无斜杠）。 */
const CLOUD_URL = "http://cloud.test";

/** 造 2 条云端下发的模型配置样例数据（新「可见列表」形状：无厂商敏感字段）。 */
function sampleConfigs(): AgentModelConfig[] {
  return [
    {
      id: "cfg-1",
      name: "GPT-4o",
      contextWindow: 128_000,
      enabled: true,
    },
    {
      id: "cfg-2",
      name: "DS Chat",
      contextWindow: 64_000,
      enabled: true,
    },
  ];
}

/** 按当前实现规则，把 AgentModelConfig 映射为期望的网关坐标行，供断言复用。 */
function expectedGatewayRow(config: AgentModelConfig): CloudModelConfigRow {
  return {
    id: config.id,
    providerType: "openai-compatible",
    baseUrl: `${CLOUD_URL}/api/v1`,
    model: config.id,
    apiKey: "__cloud__",
    name: config.name,
    contextWindow: config.contextWindow,
    enabled: config.enabled,
  };
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
    const config = {
      getOrThrow: jest.fn().mockReturnValue(CLOUD_URL),
    };
    const emitter = {
      emit: jest.fn(),
    };
    const service = new ModelConfigSyncService(
      cloud as never,
      identity as never,
      account,
      modelConfig as never,
      config as never,
      emitter as never,
    );
    return { account, cloud, identity, modelConfig, config, emitter, service };
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
      sampleConfigs().map(expectedGatewayRow),
    );
    expect(ctxDuringReplace).toBe("u1");
  });

  it("云配置写成指向网关的 openai-compatible 行（provider_type/base_url/model/api_key 均落网关坐标形状）", async () => {
    const { cloud, identity, modelConfig, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue([
      { id: "m1", name: "GPT4o", contextWindow: 128_000, enabled: true },
    ]);

    await service.syncNow("u1");

    expect(modelConfig.replaceCloudConfigs).toHaveBeenCalledWith([
      expect.objectContaining({
        providerType: "openai-compatible",
        baseUrl: expect.stringMatching(/\/api\/v1$/),
        model: "m1",
        apiKey: "__cloud__",
        name: "GPT4o",
        contextWindow: 128_000,
        enabled: true,
      }),
    ]);
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

  describe("事件驱动触发源（轮询已删）", () => {
    it("relay 连接成功事件 → syncNow 该账号", async () => {
      const { cloud, identity, modelConfig, service } = build();
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      cloud.get.mockResolvedValue(sampleConfigs());

      await service.onRelayConnected({ cloudUserId: "u1" });

      expect(cloud.get).toHaveBeenCalledWith(
        "/api/agent/model-configs",
        "mbd_x",
      );
      expect(modelConfig.replaceCloudConfigs).toHaveBeenCalled();
    });

    it("云端模型配置变更事件 → syncNow 该账号", async () => {
      const { cloud, identity, modelConfig, service } = build();
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      cloud.get.mockResolvedValue(sampleConfigs());

      await service.onModelConfigChanged({ cloudUserId: "u1" });

      expect(cloud.get).toHaveBeenCalled();
      expect(modelConfig.replaceCloudConfigs).toHaveBeenCalled();
    });

    it("syncNow 成功后 emit model-config.updated（前端刷新信号）", async () => {
      const { cloud, identity, emitter, service } = build();
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      cloud.get.mockResolvedValue(sampleConfigs());

      await service.syncNow("u1");

      expect(emitter.emit).toHaveBeenCalledWith("model-config.updated", {
        cloudUserId: "u1",
      });
    });

    it("syncNow 失败不 emit 前端刷新事件", async () => {
      const { cloud, identity, emitter, service } = build();
      identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
      cloud.get.mockRejectedValue(new Error("boom"));

      await service.syncNow("u1");

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
