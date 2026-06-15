import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { AccountContextService } from "@meshbot/agent";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { CronJob } from "../entities/cron-job.entity";
import { ScheduleService } from "./schedule.service";

/** 默认测试账号：作用域仓库要求每次调用都处于账号上下文内。 */
const DEFAULT_USER = "test-user";

/**
 * 构建一个自动包账号上下文的 service 代理：每个方法调用都跑在指定账号上下文内，
 * 让既有单测无需逐一改写。隔离测试用 rawService + ctx.run 显式切账号。
 * 仅包账号面方法；listAllForBootstrap 跨账号（无上下文）走 rawService。
 */
function wrapInAccount(
  target: ScheduleService,
  ctx: AccountContextService,
  user: string,
): ScheduleService {
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

/** 辅助函数：向 cron_jobs 表直接植入带 cloudUserId 的行（绕过 ALS）。 */
async function seedCronJob(
  ds: DataSource,
  overrides: {
    cloudUserId: string;
    sessionId?: string;
    title?: string;
    enabled?: boolean;
  },
): Promise<CronJob> {
  const repo = ds.getRepository(CronJob);
  const entity = repo.create({
    id: randomUUID(),
    cloudUserId: overrides.cloudUserId,
    sessionId: overrides.sessionId ?? "s1",
    title: overrides.title ?? "Seeded",
    prompt: "p",
    kind: "cron",
    cronExpr: "0 7 * * *",
    timezone: "UTC",
    runAt: null,
    enabled: overrides.enabled ?? true,
    lastFiredAt: null,
    nextFireAt: new Date(Date.now() + 60_000),
  });
  return repo.save(entity);
}

describe("ScheduleService CRUD", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  /** 真实 service（不包账号上下文，供 ctx.run 显式包裹的隔离测试用）。 */
  let rawService: ScheduleService;
  /** 自动包 DEFAULT_USER 账号上下文的 service 代理，供既有单测复用。 */
  let svc: ScheduleService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [CronJob],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    rawService = new ScheduleService(ds.getRepository(CronJob), scopedFactory);
    svc = wrapInAccount(rawService, ctx, DEFAULT_USER);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("create(cron) 落库 + 算 nextFireAt", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "morning",
      prompt: "good morning",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(job.id).toBeTruthy();
    expect(job.nextFireAt).toBeInstanceOf(Date);
    expect(job.enabled).toBe(true);
    expect(job.cloudUserId).toBe(DEFAULT_USER);
  });

  it("create(once) 落库 + nextFireAt = runAt", async () => {
    const runAt = new Date(Date.now() + 60_000);
    const job = await svc.create({
      sessionId: "s1",
      title: "later",
      prompt: "hi",
      kind: "once",
      runAt: runAt.toISOString(),
    });
    expect(job.runAt?.getTime()).toBe(runAt.getTime());
    expect(job.nextFireAt?.getTime()).toBe(runAt.getTime());
  });

  it("list 默认按 createdAt desc；按 sessionId 过滤", async () => {
    await svc.create({
      sessionId: "sA",
      title: "a",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await svc.create({
      sessionId: "sB",
      title: "b",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 8 * * *",
      timezone: "UTC",
    });
    const all = await svc.list();
    expect(all).toHaveLength(2);
    const onlyA = await svc.list({ sessionId: "sA" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].sessionId).toBe("sA");
  });

  it("findById 不存在 → NotFound", async () => {
    await expect(svc.findById(randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("setEnabled 翻 enabled 字段", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    const updated = await svc.setEnabled(job.id, false);
    expect(updated.enabled).toBe(false);
  });

  it("delete 删除一行", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await svc.delete(job.id);
    await expect(svc.findById(job.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("deleteBySession 删该 session 全部", async () => {
    await svc.create({
      sessionId: "sA",
      title: "a",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await svc.create({
      sessionId: "sB",
      title: "b",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 8 * * *",
      timezone: "UTC",
    });
    await svc.deleteBySession("sA");
    expect(await svc.list()).toHaveLength(1);
  });

  it("markFired 更新 lastFiredAt + nextFireAt + 可选 enabled", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "once",
      runAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const now = new Date();
    await svc.markFired(job.id, { lastFiredAt: now, enabled: false });
    const after = await svc.findById(job.id);
    expect(after.enabled).toBe(false);
    expect(after.lastFiredAt?.getTime()).toBe(now.getTime());
  });

  it("无账号上下文调用作用域方法抛错", async () => {
    await expect(rawService.list()).rejects.toThrow();
  });
});

describe("ScheduleService registry sink", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let svc: ScheduleService;
  const calls: Array<["reg" | "dereg", string]> = [];

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [CronJob],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    const rawService = new ScheduleService(
      ds.getRepository(CronJob),
      scopedFactory,
    );
    svc = wrapInAccount(rawService, ctx, DEFAULT_USER);
    calls.length = 0;
    svc.setRegistrySink({
      register: (j) => {
        calls.push(["reg", j.id]);
      },
      deregister: (id) => {
        calls.push(["dereg", id]);
      },
    });
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("create → sink.register；delete → sink.deregister", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    expect(calls).toContainEqual(["reg", job.id]);
    await svc.delete(job.id);
    expect(calls).toContainEqual(["dereg", job.id]);
  });

  it("setEnabled(true→false) → deregister；(false→true) → register", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    calls.length = 0;
    await svc.setEnabled(job.id, false);
    expect(calls).toEqual([["dereg", job.id]]);
    calls.length = 0;
    await svc.setEnabled(job.id, true);
    expect(calls).toEqual([["reg", job.id]]);
  });
});

describe("ScheduleService 账号隔离（ScopedRepository）", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  /** 真实 service（不包账号上下文，供 ctx.run 显式包裹）。 */
  let rawService: ScheduleService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [CronJob],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    rawService = new ScheduleService(ds.getRepository(CronJob), scopedFactory);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** 在指定账号上下文内创建一条 cron job。 */
  function createForUser(user: string, title: string): Promise<CronJob> {
    return ctx.run(user, () =>
      rawService.create({
        sessionId: "s1",
        title,
        prompt: "p",
        kind: "cron",
        cronExpr: "0 7 * * *",
        timezone: "UTC",
      }),
    );
  }

  it("账号 A 的任务对账号 B 不可见（list）", async () => {
    await createForUser("u1", "A Job");
    await createForUser("u2", "B Job");

    const u1All = await ctx.run("u1", () => rawService.list());
    expect(u1All).toHaveLength(1);
    expect(u1All[0].title).toBe("A Job");

    const u2All = await ctx.run("u2", () => rawService.list());
    expect(u2All).toHaveLength(1);
    expect(u2All[0].title).toBe("B Job");
  });

  it("账号 B 无法通过 findById 读取账号 A 的任务（NOT_FOUND）", async () => {
    const aJob = await createForUser("u1", "A Job");
    await expect(
      ctx.run("u2", () => rawService.findById(aJob.id)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("账号 B 无法 setEnabled 账号 A 的任务（NOT_FOUND，数据不变）", async () => {
    const aJob = await createForUser("u1", "A Job");
    await expect(
      ctx.run("u2", () => rawService.setEnabled(aJob.id, false)),
    ).rejects.toBeInstanceOf(NotFoundException);

    const original = await ctx.run("u1", () => rawService.findById(aJob.id));
    expect(original.enabled).toBe(true);
  });

  it("账号 B 的 delete 不影响账号 A 的任务（作用域 where 合并）", async () => {
    const aJob = await createForUser("u1", "A Job");
    // B 用 A 的 id 调 delete：作用域 where 合并 u2，命中 0 行，A 行仍在
    await ctx.run("u2", () => rawService.delete(aJob.id));
    const stillThere = await ctx.run("u1", () => rawService.findById(aJob.id));
    expect(stillThere.id).toBe(aJob.id);
  });

  it("账号 B 无法通过 markFired 篡改账号 A 的任务", async () => {
    const aJob = await createForUser("u1", "A Job");
    await ctx.run("u2", () =>
      rawService.markFired(aJob.id, {
        lastFiredAt: new Date(),
        enabled: false,
      }),
    );
    const original = await ctx.run("u1", () => rawService.findById(aJob.id));
    expect(original.enabled).toBe(true);
    expect(original.lastFiredAt).toBeNull();
  });

  it("seed 直接植入：两账号 list 不串台", async () => {
    await seedCronJob(ds, { cloudUserId: "u1", title: "Seeded-A" });
    await seedCronJob(ds, { cloudUserId: "u2", title: "Seeded-B" });

    const u1All = await ctx.run("u1", () => rawService.list());
    expect(u1All.map((r) => r.title)).toEqual(["Seeded-A"]);

    const u2All = await ctx.run("u2", () => rawService.list());
    expect(u2All.map((r) => r.title)).toEqual(["Seeded-B"]);
  });

  it("listAllForBootstrap 跨账号返回两账号的 enabled 任务（无需上下文）", async () => {
    await seedCronJob(ds, { cloudUserId: "u1", title: "A-enabled" });
    await seedCronJob(ds, { cloudUserId: "u2", title: "B-enabled" });
    await seedCronJob(ds, {
      cloudUserId: "u1",
      title: "A-disabled",
      enabled: false,
    });

    // 关键：不在任何账号上下文内调用，也不抛 NO_ACCOUNT_CONTEXT
    const all = await rawService.listAllForBootstrap();
    const titles = all.map((j) => j.title).sort();
    expect(titles).toEqual(["A-enabled", "B-enabled"]);
  });
});
