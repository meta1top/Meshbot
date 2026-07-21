import { describe, expect, it } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service";
import type { ActiveModelConfig } from "../../src/config/model-config.reader";
import type { ModelConfigReadPort } from "../../src/graph/model-config-read.port";
import { ModelResolver } from "../../src/graph/model-resolver.service";
import { ModelRunContext } from "../../src/graph/model-run-context";

/**
 * Critical C-1 修复后的回归：ModelResolver 不再直读 sqlite，改经
 * MODEL_CONFIG_READ_PORT 解析。这里用一个按账号+id 建模的 fake port 模拟
 * ModelConfigService 合并视图（本地 + 云端）的行为，覆盖：
 * - 无覆盖时解析账号 enabled 配置
 * - 覆盖 id 优先，且可用未 enabled 的配置（resolveById 不过滤 enabled，同
 *   ModelConfigService.findByIdOrName）
 * - 覆盖 id 查不到时回退账号 enabled 配置
 */

interface FakeRow {
  id: string;
  acct: string;
  enabled: boolean;
  cfg: ActiveModelConfig;
}

function makeFakePort(
  account: AccountContextService,
  rows: FakeRow[],
): ModelConfigReadPort {
  return {
    async resolveActive() {
      const acct = account.get();
      return rows.find((r) => r.acct === acct && r.enabled)?.cfg ?? null;
    },
    async resolveById(id: string) {
      const acct = account.get();
      return rows.find((r) => r.id === id && r.acct === acct)?.cfg ?? null;
    },
  };
}

const ROWS: FakeRow[] = [
  {
    id: "mc-default",
    acct: "u1",
    enabled: true,
    cfg: {
      providerType: "openai",
      model: "gpt-a",
      name: "默认",
      apiKey: "k",
      baseUrl: "",
      isCloudModel: false,
    },
  },
  {
    id: "mc-alt",
    acct: "u1",
    enabled: false,
    cfg: {
      providerType: "openai-compatible",
      model: "ds-b",
      name: "备用",
      apiKey: "k",
      baseUrl: "",
      isCloudModel: false,
    },
  },
];

describe("ModelResolver 覆盖解析", () => {
  function make() {
    const account = new AccountContextService();
    const runCtx = new ModelRunContext();
    const modelConfigPort = makeFakePort(account, ROWS);
    const resolver = new ModelResolver(account, runCtx, modelConfigPort);
    return { account, runCtx, resolver };
  }

  it("无覆盖解析 enabled 配置；meta 写进 run 上下文", async () => {
    const { account, runCtx, resolver } = make();
    await account.run("u1", () =>
      runCtx.run(null, async () => {
        await resolver.resolveModel();
        expect(resolver.getMeta()).toEqual({
          providerType: "openai",
          model: "gpt-a",
          modelName: "默认",
        });
      }),
    );
  });

  it("覆盖 id 优先且可用未启用配置", async () => {
    const { account, runCtx, resolver } = make();
    await account.run("u1", () =>
      runCtx.run("mc-alt", async () => {
        await resolver.resolveModel();
        expect(resolver.getMeta()).toEqual({
          providerType: "openai-compatible",
          model: "ds-b",
          modelName: "备用",
        });
      }),
    );
  });

  it("覆盖 id 不存在 → 回退账号默认模型（云端删模型后会话不卡死）", async () => {
    const { account, runCtx, resolver } = make();
    await account.run("u1", () =>
      runCtx.run("mc-404", async () => {
        await resolver.resolveModel();
        // 回退 enabled 默认配置（mc-default），而不是抛错卡死消费循环
        expect(resolver.getMeta()).toEqual({
          providerType: "openai",
          model: "gpt-a",
          modelName: "默认",
        });
      }),
    );
  });
});
