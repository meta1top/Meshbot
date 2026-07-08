import { AccountContextService } from "@meshbot/lib-agent";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { Setting } from "../entities/setting.entity";
import { SettingService } from "./setting.service";

/** 默认测试账号：作用域仓库要求每次调用都处于账号上下文内。 */
const DEFAULT_USER = "test-user";

/**
 * 构建一个自动包账号上下文的 service 代理：每个方法调用都跑在指定账号上下文内，
 * 让既有单测无需逐一改写。隔离测试用 rawService + ctx.run 显式切账号。
 */
function wrapInAccount(
  target: SettingService,
  ctx: AccountContextService,
  user: string,
): SettingService {
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

/** 辅助函数：向 settings 表直接植入带 cloudUserId 的行（绕过 ALS）。 */
async function seedSetting(
  ds: DataSource,
  overrides: { cloudUserId: string; key: string; value: string },
): Promise<Setting> {
  const repo = ds.getRepository(Setting);
  const entity = repo.create(overrides);
  return repo.save(entity);
}

describe("SettingService", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  /** 真实 service（不包账号上下文，供 ctx.run 显式包裹的隔离测试用）。 */
  let rawService: SettingService;
  /** 自动包 DEFAULT_USER 账号上下文的 service 代理，供既有单测复用。 */
  let service: SettingService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Setting],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    rawService = new SettingService(ds.getRepository(Setting), scopedFactory);
    service = wrapInAccount(rawService, ctx, DEFAULT_USER);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("set 落库一行并自动盖上 cloudUserId", async () => {
    const result = await service.set("theme", "dark");
    expect(result.key).toBe("theme");
    expect(result.value).toBe("dark");
    expect(result.cloudUserId).toBe(DEFAULT_USER);
  });

  it("get 返回已设定的值", async () => {
    await service.set("language", "zh");
    const val = await service.get("language");
    expect(val).toBe("zh");
  });

  it("get 未设定的 key 返回 null", async () => {
    const val = await service.get("nonexistent");
    expect(val).toBeNull();
  });

  it("set 同一 key 重复调用覆盖旧值（upsert）", async () => {
    await service.set("theme", "light");
    await service.set("theme", "dark");
    const val = await service.get("theme");
    expect(val).toBe("dark");
    // 只有一行
    const all = await service.findAll();
    expect(all).toHaveLength(1);
  });

  it("findAll 返回当前账号所有设置", async () => {
    await service.set("k1", "v1");
    await service.set("k2", "v2");
    const all = await service.findAll();
    expect(all).toHaveLength(2);
  });

  it("remove 删除指定 key 后 get 返回 null", async () => {
    await service.set("temp", "value");
    await service.remove("temp");
    const val = await service.get("temp");
    expect(val).toBeNull();
  });

  it("remove 不存在的 key 不报错", async () => {
    await expect(service.remove("nonexistent")).resolves.toBeUndefined();
  });

  it("无账号上下文调用作用域方法抛错", async () => {
    await expect(rawService.findAll()).rejects.toThrow();
  });

  describe("账号隔离（ScopedRepository，复合主键）", () => {
    it("两账号设置相同 key 各读各自的值（复合主键隔离）", async () => {
      await ctx.run("u1", () => rawService.set("theme", "dark"));
      await ctx.run("u2", () => rawService.set("theme", "light"));

      const u1Val = await ctx.run("u1", () => rawService.get("theme"));
      expect(u1Val).toBe("dark");

      const u2Val = await ctx.run("u2", () => rawService.get("theme"));
      expect(u2Val).toBe("light");
    });

    it("账号 A 的设置对账号 B 不可见（findAll）", async () => {
      await ctx.run("u1", () => rawService.set("k1", "v1"));
      await ctx.run("u2", () => rawService.set("k2", "v2"));

      const u1All = await ctx.run("u1", () => rawService.findAll());
      expect(u1All).toHaveLength(1);
      expect(u1All[0].key).toBe("k1");

      const u2All = await ctx.run("u2", () => rawService.findAll());
      expect(u2All).toHaveLength(1);
      expect(u2All[0].key).toBe("k2");
    });

    it("账号 A 的 remove 不影响账号 B 的同名 key", async () => {
      await ctx.run("u1", () => rawService.set("theme", "dark"));
      await ctx.run("u2", () => rawService.set("theme", "light"));

      await ctx.run("u1", () => rawService.remove("theme"));

      // u1 的已删除
      const u1Val = await ctx.run("u1", () => rawService.get("theme"));
      expect(u1Val).toBeNull();

      // u2 的不受影响
      const u2Val = await ctx.run("u2", () => rawService.get("theme"));
      expect(u2Val).toBe("light");
    });

    it("直接植入行（seed）：两账号相同 key 不串台", async () => {
      await seedSetting(ds, { cloudUserId: "u1", key: "mode", value: "a" });
      await seedSetting(ds, { cloudUserId: "u2", key: "mode", value: "b" });

      const u1Val = await ctx.run("u1", () => rawService.get("mode"));
      expect(u1Val).toBe("a");

      const u2Val = await ctx.run("u2", () => rawService.get("mode"));
      expect(u2Val).toBe("b");
    });

    it("账号各自 findAll 只统计自己的行数", async () => {
      await ctx.run("u1", () => rawService.set("a", "1"));
      await ctx.run("u1", () => rawService.set("b", "2"));
      await ctx.run("u2", () => rawService.set("a", "x"));

      const u1All = await ctx.run("u1", () => rawService.findAll());
      expect(u1All).toHaveLength(2);

      const u2All = await ctx.run("u2", () => rawService.findAll());
      expect(u2All).toHaveLength(1);
    });
  });
});
