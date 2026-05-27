import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { CronJob } from "../entities/cron-job.entity";
import { ScheduleService } from "./schedule.service";

describe("ScheduleService CRUD", () => {
  let ds: DataSource;
  let svc: ScheduleService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [CronJob],
      synchronize: true,
    });
    await ds.initialize();
    svc = new ScheduleService(ds.getRepository(CronJob));
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
});

describe("ScheduleService registry sink", () => {
  let ds: DataSource;
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
    svc = new ScheduleService(ds.getRepository(CronJob));
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
