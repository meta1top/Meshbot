import { AccountContextService } from "@meshbot/lib-agent";
import {
  Column,
  DataSource,
  Entity,
  PrimaryColumn,
  type Repository,
} from "typeorm";
import { ScopedRepository } from "./scoped-repository";
import { ScopedRepositoryFactory } from "./scoped-repository.factory";

@Entity("scoped_test")
class ScopedTestEntity {
  @PrimaryColumn() id!: string;
  @Column({ name: "cloud_user_id", type: "text" }) cloudUserId!: string;
  @Column({ type: "text" }) value!: string;
}

describe("ScopedRepository", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let rawRepo: Repository<ScopedTestEntity>;
  let scoped: ScopedRepository<ScopedTestEntity>;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [ScopedTestEntity],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    rawRepo = ds.getRepository(ScopedTestEntity);
    const factory = new ScopedRepositoryFactory(ctx);
    scoped = factory.create(rawRepo);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("save 自动带上当前账号 cloudUserId", async () => {
    await ctx.run("u1", () => scoped.save({ id: "a", value: "x" }));
    expect((await rawRepo.findOneBy({ id: "a" }))?.cloudUserId).toBe("u1");
  });

  it("save 跨账号（实体已带他账号 cloudUserId）被拒绝", async () => {
    await expect(
      ctx.run("u1", () =>
        scoped.save({ id: "b", cloudUserId: "u2", value: "x" }),
      ),
    ).rejects.toThrow(); // AppError CROSS_ACCOUNT_WRITE
  });

  it("find 自动按当前账号过滤", async () => {
    await rawRepo.save([
      { id: "a", cloudUserId: "u1", value: "x" },
      { id: "b", cloudUserId: "u2", value: "y" },
    ]);
    const rows = await ctx.run("u1", () => scoped.find());
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("findOneBy 合并账号过滤（他账号同条件不可见）", async () => {
    await rawRepo.save([
      { id: "a", cloudUserId: "u1", value: "x" },
      { id: "a2", cloudUserId: "u2", value: "x" },
    ]);
    expect(
      await ctx.run("u2", () => scoped.findOneBy({ value: "x" })),
    ).toBeTruthy();
    expect(
      (await ctx.run("u2", () => scoped.findOneBy({ value: "x" })))?.id,
    ).toBe("a2");
  });

  it("update 限定当前账号（不误改他账号同条件行）", async () => {
    await rawRepo.save([
      { id: "a", cloudUserId: "u1", value: "x" },
      { id: "b", cloudUserId: "u2", value: "x" },
    ]);
    await ctx.run("u1", () => scoped.update({ value: "x" }, { value: "z" }));
    expect((await rawRepo.findOneBy({ id: "b" }))?.value).toBe("x");
    expect((await rawRepo.findOneBy({ id: "a" }))?.value).toBe("z");
  });

  it("delete 限定当前账号", async () => {
    await rawRepo.save([
      { id: "a", cloudUserId: "u1", value: "x" },
      { id: "b", cloudUserId: "u2", value: "x" },
    ]);
    await ctx.run("u1", () => scoped.delete({ value: "x" }));
    expect(await rawRepo.findOneBy({ id: "a" })).toBeNull();
    expect(await rawRepo.findOneBy({ id: "b" })).toBeTruthy();
  });

  it("无上下文调用抛错", async () => {
    await expect(scoped.find()).rejects.toThrow();
  });

  it("unscoped() 绕过过滤（系统级读全部）", async () => {
    await rawRepo.save([
      { id: "a", cloudUserId: "u1", value: "x" },
      { id: "b", cloudUserId: "u2", value: "y" },
    ]);
    expect((await scoped.unscoped().find()).length).toBe(2);
  });

  it("count 按当前账号", async () => {
    await rawRepo.save([
      { id: "a", cloudUserId: "u1", value: "x" },
      { id: "b", cloudUserId: "u2", value: "y" },
    ]);
    expect(await ctx.run("u1", () => scoped.count())).toBe(1);
  });

  it("save 数组：每个元素都带上当前账号", async () => {
    await ctx.run("u1", () =>
      scoped.save([
        { id: "m1", value: "x" },
        { id: "m2", value: "y" },
      ]),
    );
    expect((await rawRepo.findOneBy({ id: "m1" }))?.cloudUserId).toBe("u1");
    expect((await rawRepo.findOneBy({ id: "m2" }))?.cloudUserId).toBe("u1");
  });

  it("save 数组含跨账号元素被拒绝", async () => {
    await expect(
      ctx.run("u1", () =>
        scoped.save([
          { id: "ok", value: "x" },
          { id: "bad", cloudUserId: "u2", value: "y" },
        ]),
      ),
    ).rejects.toThrow();
  });
});
