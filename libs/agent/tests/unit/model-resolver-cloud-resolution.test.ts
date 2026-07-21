import { describe, expect, it, vi } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service";
import type { ActiveModelConfig } from "../../src/config/model-config.reader";
import { CLOUD_GATEWAY_API_KEY_PLACEHOLDER } from "../../src/config/model-config.reader";
import type { CloudTokenPort } from "../../src/graph/cloud-token.port";
import type { ModelConfigReadPort } from "../../src/graph/model-config-read.port";
import { ModelResolver } from "../../src/graph/model-resolver.service";
import { ModelRunContext } from "../../src/graph/model-run-context";

/**
 * Critical C-1 运行时验证：证明 ModelResolver 真的能把云端模型解析出来，而不
 * 是像回归前那样——`readActiveModelConfig`/`readModelConfigById` 直读 sqlite
 * `model_configs` 表，T3 迁移后云端 `source='cloud'` 行永不落库，运行时必然
 * 解析不出（会抛"当前账号没有启用的模型配置"或静默回退本地模型）。
 *
 * 这里不 mock `resolveModel()` 本身：注入一个满足 `ModelConfigReadPort` 接口
 * 契约的 fake（数据形状与 server-agent `ModelConfigReadPort` 实现——委托
 * `ModelConfigService` 合并视图——映射出的 `ActiveModelConfig` 完全一致：
 * `isCloudModel` 由 `apiKey === CLOUD_GATEWAY_API_KEY_PLACEHOLDER` 判定），
 * 走真实的 `resolveModel()` → `refreshCloudToken()` → `createChatModel()`
 * 路径，只在网络边界（fetch）打桩，不触碰实际厂商 API。
 */
describe("ModelResolver 云端模型运行时解析（Critical C-1）", () => {
  const CLOUD_CFG: ActiveModelConfig = {
    providerType: "openai-compatible",
    model: "cloud-cfg-id-1",
    name: "云端 GPT-4o",
    apiKey: CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
    baseUrl: "http://gateway.test/api/v1",
    isCloudModel: true,
  };

  function makeResolver(opts: {
    resolveActive?: ActiveModelConfig | null;
    resolveById?: ActiveModelConfig | null;
    cloudTokenPort?: CloudTokenPort;
  }) {
    const account = new AccountContextService();
    const runCtx = new ModelRunContext();
    const modelConfigPort: ModelConfigReadPort = {
      resolveActive: async () => opts.resolveActive ?? null,
      resolveById: async () => opts.resolveById ?? null,
    };
    const resolver = new ModelResolver(
      account,
      runCtx,
      modelConfigPort,
      undefined,
      undefined,
      opts.cloudTokenPort,
    );
    return { account, runCtx, resolver };
  }

  it("只有云端模型的账号：resolveModel() 不抛、正常解析出云端 chat model", async () => {
    const cloudTokenPort: CloudTokenPort = {
      resolve: async () => "device-token-x",
    };
    const resolveSpy = vi.spyOn(cloudTokenPort, "resolve");
    const { account, runCtx, resolver } = makeResolver({
      resolveActive: CLOUD_CFG, // 该账号只有这一条云端配置，无本地行
      cloudTokenPort,
    });

    const model = await account.run("u-cloud-only", () =>
      runCtx.run(null, () => resolver.resolveModel()),
    );

    // 解析出了 chat model（旧 bug 下这里会抛"当前账号没有启用的模型配置"）
    expect(model).toBeDefined();
    expect(typeof model.invoke).toBe("function");
    // getMeta() 是该云端模型（而非回退本地/unknown）
    expect(resolver.getMeta()).toEqual({
      providerType: "openai-compatible",
      model: "cloud-cfg-id-1",
      modelName: "云端 GPT-4o",
    });
    // 云端分支：refreshCloudToken() 必须触发 CLOUD_TOKEN_PORT.resolve()
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("会话绑云端模型 id：resolveById 命中云端配置（overrideId 分支）", async () => {
    const cloudTokenPort: CloudTokenPort = {
      resolve: async () => "device-token-y",
    };
    const resolveSpy = vi.spyOn(cloudTokenPort, "resolve");
    const { account, runCtx, resolver } = makeResolver({
      resolveActive: null, // 无账号默认模型——必须靠 override 才能解析成功
      resolveById: CLOUD_CFG,
      cloudTokenPort,
    });

    const model = await account.run("u-override", () =>
      runCtx.run(CLOUD_CFG.model, () => resolver.resolveModel()),
    );

    expect(model).toBeDefined();
    expect(resolver.getMeta()).toEqual({
      providerType: "openai-compatible",
      model: "cloud-cfg-id-1",
      modelName: "云端 GPT-4o",
    });
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("getTitleModel() 同样能解析云端模型（旁路径，独立于 resolveModel）", async () => {
    const cloudTokenPort: CloudTokenPort = {
      resolve: async () => "device-token-z",
    };
    const { account, resolver } = makeResolver({
      resolveActive: CLOUD_CFG,
      cloudTokenPort,
    });

    const model = await account.run("u-title", () => resolver.getTitleModel());
    expect(model).toBeDefined();
  });

  it("云端模型无 CLOUD_TOKEN_PORT（测试/无 server-agent 环境）：仍解析出模型不抛", async () => {
    // @Optional：未绑定端口时静默跳过 token 刷新，云请求带空 Bearer，由网关侧
    // 鉴权拒绝（语义见 llm.factory.ts buildCloudFetch），但 resolveModel() 本身
    // 不应因为端口缺失而失败。
    const { account, runCtx, resolver } = makeResolver({
      resolveActive: CLOUD_CFG,
    });
    const model = await account.run("u-no-port", () =>
      runCtx.run(null, () => resolver.resolveModel()),
    );
    expect(model).toBeDefined();
  });
});
