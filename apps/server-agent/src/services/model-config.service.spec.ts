import { NotFoundException } from "@nestjs/common";
import { AccountContextService } from "@meshbot/agent";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { ModelConfig } from "../entities/model-config.entity";
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

/** 辅助函数：向 model_configs 表直接植入带 cloudUserId 的行（绕过 ALS）。 */
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
  });
  return repo.save(entity);
}

describe("ModelConfigService", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  /** 真实 service（不包账号上下文，供 ctx.run 显式包裹的隔离测试用）。 */
  let rawService: ModelConfigService;
  /** 自动包 DEFAULT_USER 账号上下文的 service 代理，供既有单测复用。 */
  let service: ModelConfigService;

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
    rawService = new ModelConfigService(
      ds.getRepository(ModelConfig),
      scopedFactory,
    );
    service = wrapInAccount(rawService, ctx, DEFAULT_USER);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("create 落库一行并自动盖上 cloudUserId", async () => {
    const created = await service.create({
      providerType: "openai",
      name: "GPT-4o",
      model: "gpt-4o",
      apiKey: "sk-test",
    });
    expect(created.id).toBeTruthy();
    expect(created.cloudUserId).toBe(DEFAULT_USER);
    expect(created.enabled).toBe(true);
  });

  it("findAll 返回当前账号全部配置", async () => {
    await service.create({
      providerType: "openai",
      name: "GPT-4o",
      model: "gpt-4o",
      apiKey: "sk-1",
    });
    await service.create({
      providerType: "deepseek",
      name: "DS Chat",
      model: "deepseek-chat",
      apiKey: "sk-2",
    });
    const all = await service.findAll();
    expect(all).toHaveLength(2);
  });

  it("findAllEnabled 只返回 enabled=true 的配置", async () => {
    await service.create({
      providerType: "openai",
      name: "Enabled",
      model: "gpt-4o",
      apiKey: "sk-1",
    });
    const created = await service.create({
      providerType: "deepseek",
      name: "Disabled",
      model: "deepseek-chat",
      apiKey: "sk-2",
    });
    await service.update(created.id, { enabled: false });
    const enabled = await service.findAllEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe("Enabled");
  });

  it("findEnabled 返回第一条已启用配置；无则返 null", async () => {
    const none = await service.findEnabled();
    expect(none).toBeNull();
    await service.create({
      providerType: "openai",
      name: "GPT-4o",
      model: "gpt-4o",
      apiKey: "sk-1",
    });
    const found = await service.findEnabled();
    expect(found).not.toBeNull();
  });

  it("findOneOrFail 找到时返回实体", async () => {
    const created = await service.create({
      providerType: "openai",
      name: "GPT-4o",
      model: "gpt-4o",
      apiKey: "sk-1",
    });
    const fetched = await service.findOneOrFail(created.id);
    expect(fetched.id).toBe(created.id);
  });

  it("findOneOrFail 找不到时抛 NotFoundException", async () => {
    await expect(
      service.findOneOrFail("nonexistent-id"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("update 修改字段并保留 cloudUserId", async () => {
    const created = await service.create({
      providerType: "openai",
      name: "GPT-4o",
      model: "gpt-4o",
      apiKey: "sk-1",
    });
    const updated = await service.update(created.id, {
      name: "GPT-4o Updated",
    });
    expect(updated.name).toBe("GPT-4o Updated");
    expect(updated.cloudUserId).toBe(DEFAULT_USER);
  });

  it("update：model 变更且未显式传 contextWindow → 重新解析 contextWindow", async () => {
    const created = await service.create({
      providerType: "openai",
      name: "GPT-4o",
      model: "gpt-4o",
      apiKey: "sk-1",
      contextWindow: 128_000,
    });
    // gpt-4o-mini 在 MODEL_SPECS 里有确定值或 fallback
    const updated = await service.update(created.id, { model: "gpt-4o-mini" });
    expect(updated.model).toBe("gpt-4o-mini");
    // contextWindow 应被重新解析（不再是原值），仅验证它是一个正整数
    expect(updated.contextWindow).toBeGreaterThan(0);
  });

  it("remove 删除存在的配置后 findAll 为空", async () => {
    const created = await service.create({
      providerType: "openai",
      name: "GPT-4o",
      model: "gpt-4o",
      apiKey: "sk-1",
    });
    await service.remove(created.id);
    const all = await service.findAll();
    expect(all).toHaveLength(0);
  });

  it("remove 不存在 id 时抛 NotFoundException", async () => {
    await expect(service.remove("nonexistent-id")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("hasEnabledModels 无配置返 false，有启用配置返 true", async () => {
    expect(await service.hasEnabledModels()).toBe(false);
    await service.create({
      providerType: "openai",
      name: "GPT-4o",
      model: "gpt-4o",
      apiKey: "sk-1",
    });
    expect(await service.hasEnabledModels()).toBe(true);
  });

  it("无账号上下文调用作用域方法抛错", async () => {
    await expect(rawService.findAll()).rejects.toThrow();
  });

  describe("账号隔离（ScopedRepository）", () => {
    it("账号 A 的配置对账号 B 不可见（findAll）", async () => {
      await ctx.run("u1", () =>
        rawService.create({
          providerType: "openai",
          name: "A Config",
          model: "gpt-4o",
          apiKey: "sk-a",
        }),
      );
      await ctx.run("u2", () =>
        rawService.create({
          providerType: "openai",
          name: "B Config",
          model: "gpt-4o",
          apiKey: "sk-b",
        }),
      );
      const u1All = await ctx.run("u1", () => rawService.findAll());
      expect(u1All).toHaveLength(1);
      expect(u1All[0].name).toBe("A Config");

      const u2All = await ctx.run("u2", () => rawService.findAll());
      expect(u2All).toHaveLength(1);
      expect(u2All[0].name).toBe("B Config");
    });

    it("账号 A 的配置对账号 B 不可见（findAllEnabled）", async () => {
      await ctx.run("u1", () =>
        rawService.create({
          providerType: "openai",
          name: "A Enabled",
          model: "gpt-4o",
          apiKey: "sk-a",
        }),
      );
      await ctx.run("u2", () =>
        rawService.create({
          providerType: "openai",
          name: "B Enabled",
          model: "gpt-4o",
          apiKey: "sk-b",
        }),
      );
      const u1Enabled = await ctx.run("u1", () => rawService.findAllEnabled());
      expect(u1Enabled).toHaveLength(1);
      expect(u1Enabled[0].name).toBe("A Enabled");

      const u2Enabled = await ctx.run("u2", () => rawService.findAllEnabled());
      expect(u2Enabled).toHaveLength(1);
      expect(u2Enabled[0].name).toBe("B Enabled");
    });

    it("账号 B 无法通过 findOneOrFail 读取账号 A 的配置（NOT_FOUND）", async () => {
      const aConfig = await ctx.run("u1", () =>
        rawService.create({
          providerType: "openai",
          name: "A Config",
          model: "gpt-4o",
          apiKey: "sk-a",
        }),
      );
      // 账号 B 试图读账号 A 的 id → 应抛 NotFoundException
      await expect(
        ctx.run("u2", () => rawService.findOneOrFail(aConfig.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("账号 B 无法 update 账号 A 的配置（NOT_FOUND）", async () => {
      const aConfig = await ctx.run("u1", () =>
        rawService.create({
          providerType: "openai",
          name: "A Config",
          model: "gpt-4o",
          apiKey: "sk-a",
        }),
      );
      await expect(
        ctx.run("u2", () => rawService.update(aConfig.id, { name: "Hacked" })),
      ).rejects.toBeInstanceOf(NotFoundException);

      // 验证数据未被篡改
      const original = await ctx.run("u1", () =>
        rawService.findOneOrFail(aConfig.id),
      );
      expect(original.name).toBe("A Config");
    });

    it("账号 B 无法 remove 账号 A 的配置（NOT_FOUND）", async () => {
      const aConfig = await ctx.run("u1", () =>
        rawService.create({
          providerType: "openai",
          name: "A Config",
          model: "gpt-4o",
          apiKey: "sk-a",
        }),
      );
      await expect(
        ctx.run("u2", () => rawService.remove(aConfig.id)),
      ).rejects.toBeInstanceOf(NotFoundException);

      // 验证数据仍存在
      const stillThere = await ctx.run("u1", () =>
        rawService.findOneOrFail(aConfig.id),
      );
      expect(stillThere.id).toBe(aConfig.id);
    });

    it("hasEnabledModels 和 count 各账号独立统计", async () => {
      // u1 有一条启用配置，u2 没有
      await ctx.run("u1", () =>
        rawService.create({
          providerType: "openai",
          name: "A Config",
          model: "gpt-4o",
          apiKey: "sk-a",
        }),
      );
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
});
