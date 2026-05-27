import { SchedulerRegistry } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { CronJob } from "../entities/cron-job.entity";
import { ScheduleExecutor } from "./schedule-executor.service";
import { ScheduleService } from "./schedule.service";

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

describe("ScheduleExecutor.fire", () => {
  let ds: DataSource;
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
    schedule = new ScheduleService(ds.getRepository(CronJob));
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
    );
    const job = await schedule.create({
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
    const after = await schedule.findById(job.id);
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
    );
    const job = await schedule.create({
      sessionId: "s1",
      title: "t",
      prompt: "hi",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    const oldNext = job.nextFireAt!;
    await executor.fire(job.id);
    const after = await schedule.findById(job.id);
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
    );
    const job = await schedule.create({
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
    const after = await schedule.findById(job.id);
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
    );
    const job = await schedule.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await schedule.setEnabled(job.id, false);
    await executor.fire(job.id);
    expect(sessions.appendMessage).not.toHaveBeenCalled();
  });

  it("bootstrap reload：将 enabled cron 注册到 registry；过期 once 自动 disable", async () => {
    const sessions = fakeSessions();
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
    );
    const cronJob = await schedule.create({
      sessionId: "s1",
      title: "future-cron",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    const expired = await schedule.create({
      sessionId: "s1",
      title: "expired-once",
      prompt: "p",
      kind: "once",
      runAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await executor.onApplicationBootstrap();
    expect(registry.getCronJobs().has(cronJob.id)).toBe(true);
    const expiredAfter = await schedule.findById(expired.id);
    expect(expiredAfter.enabled).toBe(false);
  });
});
