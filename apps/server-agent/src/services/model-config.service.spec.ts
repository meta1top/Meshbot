import { NotFoundException } from "@nestjs/common";
import { AccountContextService } from "@meshbot/lib-agent";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { ModelConfig } from "../entities/model-config.entity";
import type { CloudModelConfigRow } from "./model-config.service";
import { ModelConfigService } from "./model-config.service";

/** 默认测试账号：作用域仓库要求每次调用都处于账号上下文内。 */
const DEFAULT_USER = "test-user";

/**
 * 构建一个自动包账号上下文的 service 代理：每个方法调用都跑在指定账号上下文内，
 * 让既有单测无需逐一改写。隔离测试用 rawService + ctx.run 显式切账号。
 */
function wrapInAccount(
  target: ModelConfigService,
  ctx: AccountContextService,
  user: string,
): ModelConfigService {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        ctx.run(user, () =>
          (value as (...a: unknown[]) => unknown).apply(t, args),
        );
    },
  });
}

/** 辅助函数：向 model_configs 表直接植入带 cloudUserId 的行（绕过 ALS，写 REST 下线后本地测试数据只能这样造）。 */
async function seedModelConfig(
  ds: DataSource,
  overrides: {
    cloudUserId: string;
    providerType?: string;
    name?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    enabled?: boolean;
    contextWindow?: number;
    source?: "cloud" | "local";
  },
): Promise<ModelConfig> {
  const repo = ds.getRepository(ModelConfig);
  const entity = repo.create({
    cloudUserId: overrides.cloudUserId,
    providerType: overrides.providerType ?? "openai",
    name: overrides.name ?? "Test Model",
    model: overrides.model ?? "gpt-4o",
    apiKey: overrides.apiKey ?? "test-key",
    baseUrl: overrides.baseUrl ?? "",
    enabled: overrides.enabled ?? true,
    contextWindow: overrides.contextWindow ?? 128_000,
    source: overrides.source ?? "local",
  });
  return repo.save(entity);
}

/** 造一条网关坐标行样例（sync service 已完成 AgentModelConfig → 网关行映射）。 */
function cloudConfigRow(
  overrides: Partial<CloudModelConfigRow> = {},
): CloudModelConfigRow {
  // id 与 model 同源（真实实现即本地行 id=云端配置 id），跟随 overrides.model
  // 变化——否则多行 fixture 同 id 主键互覆，replaceCloudConfigs 断言只剩一行。
  const model = overrides.model ?? "cloud-cfg-1";
  return {
    id: model,
    providerType: "openai-compatible",
    name: "Cloud GPT-4o",
    model,
    apiKey: "__cloud__",
    baseUrl: "http://127.0.0.1:3200/api/v1",
    contextWindow: 128_000,
    enabled: true,
    ...overrides,
  };
}

describe("ModelConfigService", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  /** 真实 service（不包账号上下文，供 ctx.run 显式包裹的隔离测试用）。 */
  let rawService: ModelConfigService;
  /** 自动包 DEFAULT_USER 账号上下文的 service 代理，供既有单测复用。 */
  let service: ModelConfigService;

  let proxyGet: jest.Mock;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [ModelConfig],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    proxyGet = jest.fn().mockResolvedValue([]);
    rawService = new ModelConfigService(
      ds.getRepository(ModelConfig),
      scopedFactory,
      { getCloudConfigs: proxyGet } as never,
    );
    service = wrapInAccount(rawService, ctx, DEFAULT_USER);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("findAll 返回当前账号全部配置", async () => {
    await seedModelConfig(ds, { cloudUserId: DEFAULT_USER, name: "GPT-4o" });
    await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      providerType: "deepseek",
      name: "DS Chat",
      model: "deepseek-chat",
    });
    const all = await service.findAll();
    expect(all).toHaveLength(2);
  });

  it("findAllEnabled 只返回 enabled=true 的配置", async () => {
    await seedModelConfig(ds, { cloudUserId: DEFAULT_USER, name: "Enabled" });
    await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "Disabled",
      enabled: false,
    });
    const enabled = await service.findAllEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe("Enabled");
  });

  it("findEnabled 返回第一条已启用配置；无则返 null", async () => {
    const none = await service.findEnabled();
    expect(none).toBeNull();
    await seedModelConfig(ds, { cloudUserId: DEFAULT_USER, name: "GPT-4o" });
    const found = await service.findEnabled();
    expect(found).not.toBeNull();
  });

  it("findOneOrFail 找到时返回实体", async () => {
    const created = await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "GPT-4o",
    });
    const fetched = await service.findOneOrFail(created.id);
    expect(fetched.id).toBe(created.id);
  });

  it("findOneOrFail 找不到时抛 NotFoundException", async () => {
    await expect(
      service.findOneOrFail("nonexistent-id"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("hasEnabledModels 无配置返 false，有启用配置返 true", async () => {
    expect(await service.hasEnabledModels()).toBe(false);
    await seedModelConfig(ds, { cloudUserId: DEFAULT_USER, name: "GPT-4o" });
    expect(await service.hasEnabledModels()).toBe(true);
  });

  /** 造一条内存态云端坐标行（source='cloud'，proxy 返回形状）。 */
  function cloudRow(overrides: Partial<ModelConfig> = {}): ModelConfig {
    const id = overrides.id ?? "cloud-1";
    return {
      id,
      cloudUserId: DEFAULT_USER,
      providerType: "openai-compatible",
      name: "Cloud GPT-4o",
      model: id,
      apiKey: "__cloud__",
      baseUrl: "http://cloud.test/api/v1",
      enabled: true,
      contextWindow: 128_000,
      source: "cloud",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...overrides,
    } as ModelConfig;
  }

  it("findAll 合并本地 local 行 + 云端代理行", async () => {
    await seedModelConfig(ds, { cloudUserId: DEFAULT_USER, name: "Local A" });
    proxyGet.mockResolvedValue([cloudRow({ id: "cloud-1", name: "Cloud A" })]);

    const all = await service.findAll();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.source).sort()).toEqual(["cloud", "local"]);
  });

  it("findAll 只取本地 source='local'（存量 cloud 行被排除，只由代理提供云端）", async () => {
    await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "Stale Cloud",
      source: "cloud",
    });
    proxyGet.mockResolvedValue([]);

    const all = await service.findAll();
    expect(all).toHaveLength(0);
  });

  it("findAll 按 id 去重、本地优先", async () => {
    const local = await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "Local Wins",
    });
    proxyGet.mockResolvedValue([cloudRow({ id: local.id, name: "Cloud Dup" })]);

    const all = await service.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Local Wins");
    expect(all[0].source).toBe("local");
  });

  it("findAllEnabled 合并后按 enabled 过滤", async () => {
    await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "Local Off",
      enabled: false,
    });
    proxyGet.mockResolvedValue([
      cloudRow({ id: "c1", name: "Cloud On", enabled: true }),
      cloudRow({ id: "c2", name: "Cloud Off", enabled: false }),
    ]);

    const enabled = await service.findAllEnabled();
    expect(enabled.map((c) => c.name)).toEqual(["Cloud On"]);
  });

  it("findByIdOrName 本地优先命中，不打云端", async () => {
    const local = await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "Local X",
    });
    const found = await service.findByIdOrName(local.id);
    expect(found?.id).toBe(local.id);
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it("findByIdOrName 本地未命中 → 云端代理兜底", async () => {
    proxyGet.mockResolvedValue([cloudRow({ id: "cloud-9", name: "Cloud Y" })]);
    const found = await service.findByIdOrName("cloud-9");
    expect(found?.name).toBe("Cloud Y");
    expect(found?.source).toBe("cloud");
  });

  it("findByIdOrName 本地与云端都未命中 → null（云端不可达即空列表，不抛）", async () => {
    proxyGet.mockResolvedValue([]);
    const found = await service.findByIdOrName("ghost");
    expect(found).toBeNull();
  });

  it("findOneOrFail 云端 id 命中返回云端行；都无则抛 NotFound", async () => {
    proxyGet.mockResolvedValue([cloudRow({ id: "cloud-7" })]);
    const found = await service.findOneOrFail("cloud-7");
    expect(found.source).toBe("cloud");
    await expect(service.findOneOrFail("nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("hasEnabledModels 仅云端有 enabled 时也放行", async () => {
    proxyGet.mockResolvedValue([cloudRow({ id: "c1", enabled: true })]);
    expect(await service.hasEnabledModels()).toBe(true);
  });

  it("无账号上下文调用作用域方法抛错", async () => {
    await expect(rawService.findAll()).rejects.toThrow();
  });

  describe("账号隔离（ScopedRepository）", () => {
    it("账号 A 的配置对账号 B 不可见（findAll）", async () => {
      await seedModelConfig(ds, { cloudUserId: "u1", name: "A Config" });
      await seedModelConfig(ds, { cloudUserId: "u2", name: "B Config" });

      const u1All = await ctx.run("u1", () => rawService.findAll());
      expect(u1All).toHaveLength(1);
      expect(u1All[0].name).toBe("A Config");

      const u2All = await ctx.run("u2", () => rawService.findAll());
      expect(u2All).toHaveLength(1);
      expect(u2All[0].name).toBe("B Config");
    });

    it("账号 A 的配置对账号 B 不可见（findAllEnabled）", async () => {
      await seedModelConfig(ds, { cloudUserId: "u1", name: "A Enabled" });
      await seedModelConfig(ds, { cloudUserId: "u2", name: "B Enabled" });

      const u1Enabled = await ctx.run("u1", () => rawService.findAllEnabled());
      expect(u1Enabled).toHaveLength(1);
      expect(u1Enabled[0].name).toBe("A Enabled");

      const u2Enabled = await ctx.run("u2", () => rawService.findAllEnabled());
      expect(u2Enabled).toHaveLength(1);
      expect(u2Enabled[0].name).toBe("B Enabled");
    });

    it("账号 B 无法通过 findOneOrFail 读取账号 A 的配置（NOT_FOUND）", async () => {
      const aConfig = await seedModelConfig(ds, {
        cloudUserId: "u1",
        name: "A Config",
      });
      // 账号 B 试图读账号 A 的 id → 应抛 NotFoundException
      await expect(
        ctx.run("u2", () => rawService.findOneOrFail(aConfig.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("hasEnabledModels 和 count 各账号独立统计", async () => {
      // u1 有一条启用配置，u2 没有
      await seedModelConfig(ds, { cloudUserId: "u1", name: "A Config" });
      const u1Has = await ctx.run("u1", () => rawService.hasEnabledModels());
      expect(u1Has).toBe(true);

      const u2Has = await ctx.run("u2", () => rawService.hasEnabledModels());
      expect(u2Has).toBe(false);
    });

    it("直接植入行（seed）：两账号的 findAll 不串台", async () => {
      await seedModelConfig(ds, { cloudUserId: "u1", name: "Seeded-A" });
      await seedModelConfig(ds, { cloudUserId: "u2", name: "Seeded-B" });

      const u1All = await ctx.run("u1", () => rawService.findAll());
      expect(u1All.map((r) => r.name)).toEqual(["Seeded-A"]);

      const u2All = await ctx.run("u2", () => rawService.findAll());
      expect(u2All.map((r) => r.name)).toEqual(["Seeded-B"]);
    });
  });

  describe("replaceCloudConfigs（云端模型配置整体替换）", () => {
    // 本任务起 findAll() 只读本地 source='local' 行（合并视图，见上方合并用例）；
    // replaceCloudConfigs 写入的 source='cloud' 存量行不再经 findAll() 可见
    // （T3 才会移除该写入路径）。这里直接查裸仓库验证写入本身，不借道 findAll()。
    async function findAllRaw(cloudUserId: string): Promise<ModelConfig[]> {
      return ds.getRepository(ModelConfig).find({ where: { cloudUserId } });
    }

    it("存量 source='local' 行不受影响，新 cloud 行落库", async () => {
      await seedModelConfig(ds, {
        cloudUserId: "u1",
        name: "Local Kept",
        source: "local",
      });

      await ctx.run("u1", () =>
        rawService.replaceCloudConfigs([cloudConfigRow({ name: "Cloud A" })]),
      );

      const all = await findAllRaw("u1");
      expect(all).toHaveLength(2);
      const local = all.find((r) => r.source === "local");
      const cloud = all.find((r) => r.source === "cloud");
      expect(local?.name).toBe("Local Kept");
      expect(cloud?.name).toBe("Cloud A");
    });

    it("旧 cloud 行被整体替换为新一批配置（不是增量合并）", async () => {
      await seedModelConfig(ds, {
        cloudUserId: "u1",
        name: "Old Cloud",
        source: "cloud",
      });

      await ctx.run("u1", () =>
        rawService.replaceCloudConfigs([
          cloudConfigRow({ model: "cfg-1", name: "New Cloud 1" }),
          cloudConfigRow({ model: "cfg-2", name: "New Cloud 2" }),
        ]),
      );

      const cloudRows = (await findAllRaw("u1")).filter(
        (r) => r.source === "cloud",
      );
      expect(cloudRows).toHaveLength(2);
      expect(cloudRows.map((r) => r.name).sort()).toEqual([
        "New Cloud 1",
        "New Cloud 2",
      ]);
      expect(cloudRows.some((r) => r.name === "Old Cloud")).toBe(false);
    });

    it("其他账号的行不受影响（作用域 delete 只删当前账号）", async () => {
      await seedModelConfig(ds, {
        cloudUserId: "u2",
        name: "U2 Cloud",
        source: "cloud",
      });

      await ctx.run("u1", () =>
        rawService.replaceCloudConfigs([cloudConfigRow({ name: "U1 Cloud" })]),
      );

      const u2All = await findAllRaw("u2");
      expect(u2All).toHaveLength(1);
      expect(u2All[0].name).toBe("U2 Cloud");
    });

    it("云配置写成指向网关的 openai-compatible 行（不落厂商明文）", async () => {
      await ctx.run("u1", () =>
        rawService.replaceCloudConfigs([
          cloudConfigRow({
            model: "m1",
            name: "GPT4o",
            baseUrl: "http://127.0.0.1:3200/api/v1",
          }),
        ]),
      );

      const [row] = await findAllRaw("u1");
      expect(row).toMatchObject({
        providerType: "openai-compatible",
        baseUrl: expect.stringMatching(/\/api\/v1$/),
        model: "m1",
        apiKey: "__cloud__",
        source: "cloud",
      });
    });

    it("contextWindow 为 null 时落库兜底为默认值（entity 列非空）", async () => {
      await ctx.run("u1", () =>
        rawService.replaceCloudConfigs([
          cloudConfigRow({ contextWindow: null }),
        ]),
      );

      const [row] = await findAllRaw("u1");
      expect(row.contextWindow).toBe(128_000);
    });
  });
});
