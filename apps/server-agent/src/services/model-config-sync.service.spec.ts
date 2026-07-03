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
});
