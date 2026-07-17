import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentModelConfig } from "@meshbot/types";
import { CloudModelConfigProxyService } from "./cloud-model-config-proxy.service";

const CLOUD_URL = "http://cloud.test";

function sampleConfigs(): AgentModelConfig[] {
  return [
    { id: "cfg-1", name: "GPT-4o", contextWindow: 128_000, enabled: true },
    { id: "cfg-2", name: "DS Chat", contextWindow: 64_000, enabled: false },
  ];
}

function build() {
  const account = new AccountContextService();
  const cloud = { get: jest.fn() };
  const identity = { get: jest.fn() };
  const config = { getOrThrow: jest.fn().mockReturnValue(CLOUD_URL) };
  const emitter = { emit: jest.fn() };
  const service = new CloudModelConfigProxyService(
    cloud as never,
    identity as never,
    account,
    config as never,
    emitter as never,
  );
  return { account, cloud, identity, config, emitter, service };
}

describe("CloudModelConfigProxyService", () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("getCloudConfigs：device token 拉云端并映射成 source='cloud' 的网关坐标行", async () => {
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue(sampleConfigs());

    const rows = await account.run("u1", () => service.getCloudConfigs());

    expect(cloud.get).toHaveBeenCalledWith("/api/agent/model-configs", "mbd_x");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "cfg-1",
      providerType: "openai-compatible",
      baseUrl: `${CLOUD_URL}/api/v1`,
      model: "cfg-1",
      apiKey: "__cloud__",
      name: "GPT-4o",
      contextWindow: 128_000,
      enabled: true,
      source: "cloud",
      cloudUserId: "u1",
    });
  });

  it("TTL 内二次读命中缓存，不再打云端", async () => {
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue(sampleConfigs());

    await account.run("u1", () => service.getCloudConfigs());
    await account.run("u1", () => service.getCloudConfigs());

    expect(cloud.get).toHaveBeenCalledTimes(1);
  });

  it("TTL 过期后重新打云端", async () => {
    jest.useFakeTimers();
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue(sampleConfigs());

    await account.run("u1", () => service.getCloudConfigs());
    jest.advanceTimersByTime(46_000);
    await account.run("u1", () => service.getCloudConfigs());

    expect(cloud.get).toHaveBeenCalledTimes(2);
  });

  it("modelConfigChanged 清该账号缓存并 emit model-config.updated", async () => {
    const { account, cloud, identity, emitter, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue(sampleConfigs());

    await account.run("u1", () => service.getCloudConfigs());
    service.onModelConfigChanged({ cloudUserId: "u1" });
    await account.run("u1", () => service.getCloudConfigs());

    expect(cloud.get).toHaveBeenCalledTimes(2);
    expect(emitter.emit).toHaveBeenCalledWith("model-config.updated", {
      cloudUserId: "u1",
    });
  });

  it("云端不可达 → 返回空数组、不抛、不缓存（下次重试）", async () => {
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockRejectedValueOnce(new Error("network down"));

    const rows = await account.run("u1", () => service.getCloudConfigs());
    expect(rows).toEqual([]);

    cloud.get.mockResolvedValue(sampleConfigs());
    const rows2 = await account.run("u1", () => service.getCloudConfigs());
    expect(rows2).toHaveLength(2);
    expect(cloud.get).toHaveBeenCalledTimes(2);
  });

  it("无 deviceToken → 返回空数组，不打云端", async () => {
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: null });

    const rows = await account.run("u1", () => service.getCloudConfigs());
    expect(rows).toEqual([]);
    expect(cloud.get).not.toHaveBeenCalled();
  });
});
