import { randomUUID } from "node:crypto";
import { AccountContextService } from "@meshbot/agent";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import type { AccountRuntimeRegistry } from "../account/account-runtime.registry";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { CronJob } from "../entities/cron-job.entity";
import { ScheduleExecutor } from "./schedule-executor.service";
import { ScheduleService } from "./schedule.service";

/** 默认测试账号：账号面方法须在上下文内执行。 */
const DEFAULT_USER = "test-user";

function fakeSessions(opts?: { missing?: boolean }) {
  return {
    appendMessage: jest
      .fn()
      .mockResolvedValue({ messageId: "m1", queued: true }),
    findOrNull: jest
      .fn()
      .mockResolvedValue(opts?.missing ? null : { id: "s1" }),
  };
}
function fakeRunner() {
  return { kick: jest.fn() };
}

/**
 * 运行时注册表桩：fire 仅调用 has(cloudUserId) 判断账号是否在线。
 * online 列表内的账号视为已登录（运行时在线）。
 */
function fakeRuntime(online: string[] = [DEFAULT_USER]): {
  registry: AccountRuntimeRegistry;
  has: jest.Mock;
} {
  const set = new Set(online);
  const has = jest.fn((id: string) => set.has(id));
  return { registry: { has } as unknown as AccountRuntimeRegistry, has };
}

/** 在 DEFAULT_USER 上下文内创建一条任务（boot 期外的账号面写入需上下文）。 */
function createInAccount(
  ctx: AccountContextService,
  schedule: ScheduleService,
  input: Parameters<ScheduleService["create"]>[0],
): Promise<CronJob> {
  return ctx.run(DEFAULT_USER, () => schedule.create(input));
}

describe("ScheduleExecutor.fire", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let schedule: ScheduleService;
  let executor: ScheduleExecutor;
  let registry: SchedulerRegistry;

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
    schedule = new ScheduleService(ds.getRepository(CronJob), scopedFactory);
    registry = new SchedulerRegistry();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("fire(once)：投递 + disable + 写 lastFiredAt", async () => {
    const sessions = fakeSessions();
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
      ctx,
      fakeRuntime().registry,
    );
    const job = await createInAccount(ctx, schedule, {
      sessionId: "s1",
      title: "t",
      prompt: "do thing",
      kind: "once",
      runAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await executor.fire(job.id);
    expect(sessions.appendMessage).toHaveBeenCalledWith("s1", {
      messageId: expect.any(String),
      content: "do thing",
    });
    expect(runner.kick).toHaveBeenCalledWith("s1");
    const after = await ctx.run(DEFAULT_USER, () => schedule.findById(job.id));
    expect(after.enabled).toBe(false);
    expect(after.lastFiredAt).toBeTruthy();
  });

  it("fire(cron)：投递后重算 nextFireAt，保持 enabled", async () => {
    const sessions = fakeSessions();
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
      ctx,
      fakeRuntime().registry,
    );
    const job = await createInAccount(ctx, schedule, {
      sessionId: "s1",
      title: "t",
      prompt: "hi",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    const oldNext = job.nextFireAt!;
    await executor.fire(job.id);
    const after = await ctx.run(DEFAULT_USER, () => schedule.findById(job.id));
    expect(after.enabled).toBe(true);
    expect(after.lastFiredAt).toBeTruthy();
    expect(after.nextFireAt!.getTime()).toBeGreaterThanOrEqual(
      oldNext.getTime(),
    );
  });

  it("fire：session 已删 → disable，不投递", async () => {
    const sessions = fakeSessions({ missing: true });
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
      ctx,
      fakeRuntime().registry,
    );
    const job = await createInAccount(ctx, schedule, {
      sessionId: "ghost",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await executor.fire(job.id);
    expect(sessions.appendMessage).not.toHaveBeenCalled();
    expect(runner.kick).not.toHaveBeenCalled();
    const after = await ctx.run(DEFAULT_USER, () => schedule.findById(job.id));
    expect(after.enabled).toBe(false);
  });

  it("fire：job 已 disable → 直接 return", async () => {
    const sessions = fakeSessions();
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
      ctx,
      fakeRuntime().registry,
    );
    const job = await createInAccount(ctx, schedule, {
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await ctx.run(DEFAULT_USER, () => schedule.setEnabled(job.id, false));
    await executor.fire(job.id);
    expect(sessions.appendMessage).not.toHaveBeenCalled();
  });

  it("D8：账号未登录（runtime 离线）→ 不投递、不 kick，撤销该定时器", async () => {
    const sessions = fakeSessions();
    const runner = fakeRunner();
    // runtime 在线列表为空 → has(任意账号) 返回 false（账号已登出）
    const runtime = fakeRuntime([]);
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
      ctx,
      runtime.registry,
    );
    const job = await createInAccount(ctx, schedule, {
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    // 先注册定时器，验证 D8 会把它撤销
    await ctx.run(DEFAULT_USER, () => executor.register(job));
    expect(registry.getCronJobs().has(job.id)).toBe(true);

    await executor.fire(job.id);

    expect(runtime.has).toHaveBeenCalledWith(DEFAULT_USER);
    expect(sessions.appendMessage).not.toHaveBeenCalled();
    expect(runner.kick).not.toHaveBeenCalled();
    expect(registry.getCronJobs().has(job.id)).toBe(false);
  });
});

describe("ScheduleExecutor.onApplicationBootstrap", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let schedule: ScheduleService;
  let executor: ScheduleExecutor;
  let registry: SchedulerRegistry;

  /** 直接植入一行（绕过 ALS），模拟 boot 时 DB 里已有他账号的任务。 */
  async function seedCronJob(overrides: {
    cloudUserId: string;
    title?: string;
    enabled?: boolean;
  }): Promise<CronJob> {
    const repo = ds.getRepository(CronJob);
    const entity = repo.create({
      id: randomUUID(),
      cloudUserId: overrides.cloudUserId,
      sessionId: "s1",
      title: overrides.title ?? "seeded",
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
    schedule = new ScheduleService(ds.getRepository(CronJob), scopedFactory);
    registry = new SchedulerRegistry();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      fakeSessions() as never,
      fakeRunner() as never,
      ctx,
      fakeRuntime().registry,
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("boot 无账号上下文：跨账号装载所有 enabled cron 到 registry（不抛 NO_ACCOUNT_CONTEXT）", async () => {
    const aJob = await seedCronJob({ cloudUserId: "u1", title: "A-cron" });
    const bJob = await seedCronJob({ cloudUserId: "u2", title: "B-cron" });
    await seedCronJob({
      cloudUserId: "u1",
      title: "A-disabled",
      enabled: false,
    });

    // 关键：onApplicationBootstrap 不在任何账号上下文内运行
    await executor.onApplicationBootstrap();

    expect(registry.getCronJobs().has(aJob.id)).toBe(true);
    expect(registry.getCronJobs().has(bJob.id)).toBe(true);
  });

  it("boot：两个账号各自的 enabled job 都注册到 registry（6.1 跨账号装载）", async () => {
    const spy = jest.spyOn(executor, "register");
    const u1Job = await seedCronJob({ cloudUserId: "u1", title: "U1" });
    const u2Job = await seedCronJob({ cloudUserId: "u2", title: "U2" });

    await executor.onApplicationBootstrap();

    // 两个账号的 job 都进了 SchedulerRegistry
    expect(registry.getCronJobs().has(u1Job.id)).toBe(true);
    expect(registry.getCronJobs().has(u2Job.id)).toBe(true);
    // 两次 register 调用分别发生（每账号一条）
    const registeredIds = spy.mock.calls.map(([j]) => j.id);
    expect(registeredIds).toContain(u1Job.id);
    expect(registeredIds).toContain(u2Job.id);
  });

  it("boot：disabled job 不注册到 registry", async () => {
    const disabled = await seedCronJob({
      cloudUserId: "u1",
      title: "disabled",
      enabled: false,
    });
    await executor.onApplicationBootstrap();
    expect(registry.getCronJobs().has(disabled.id)).toBe(false);
  });
});
