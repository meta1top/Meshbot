import { randomUUID } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { CronExpressionParser } from "cron-parser";
import { Repository } from "typeorm";
import type { CreateCronJobInput } from "@meshbot/types-agent";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { CronJob } from "../entities/cron-job.entity";

/**
 * 写入路径上通知 SchedulerRegistry 同步的钩子。
 * 由 ScheduleExecutor 在 bootstrap 阶段挂载，避免 Service / Executor 互相注入的循环依赖。
 */
export interface ScheduleRegistrySink {
  register(job: {
    id: string;
    kind: "cron" | "once";
    cronExpr: string | null;
    timezone: string | null;
    runAt: Date | null;
  }): Promise<void> | void;
  deregister(jobId: string): void;
}

/** ScheduleService CRUD —— SchedulerRegistry 同步在 ScheduleExecutor 接入（按账号隔离）。 */
@Injectable()
export class ScheduleService {
  /** CronJob 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly repo: ScopedRepository<CronJob>;

  constructor(
    @InjectRepository(CronJob)
    rawRepo: Repository<CronJob>,
    scopedFactory: ScopedRepositoryFactory,
  ) {
    this.repo = scopedFactory.create(rawRepo);
  }

  private sink: ScheduleRegistrySink | null = null;

  /** 由 ScheduleExecutor 启动时挂载。 */
  setRegistrySink(sink: ScheduleRegistrySink): void {
    this.sink = sink;
  }

  /** 计算下次触发时刻（cron / once 通用入口）。 */
  static computeNextFireAt(
    input: Pick<CreateCronJobInput, "kind" | "cronExpr" | "timezone" | "runAt">,
  ): Date {
    if (input.kind === "once") {
      return new Date(input.runAt as string);
    }
    return CronExpressionParser.parse(input.cronExpr as string, {
      tz: input.timezone ?? undefined,
    })
      .next()
      .toDate();
  }

  /** 新增计划任务，自动计算 nextFireAt（自动盖上当前账号 cloudUserId）。 */
  async create(input: CreateCronJobInput): Promise<CronJob> {
    const id = randomUUID();
    const nextFireAt = ScheduleService.computeNextFireAt(input);
    const entity = await this.repo.save({
      id,
      sessionId: input.sessionId,
      title: input.title,
      prompt: input.prompt,
      kind: input.kind,
      cronExpr: input.cronExpr ?? null,
      timezone: input.timezone ?? null,
      runAt: input.runAt ? new Date(input.runAt) : null,
      enabled: true,
      lastFiredAt: null,
      nextFireAt,
    } as CronJob);
    if (entity.enabled) await this.sink?.register(entity);
    return entity;
  }

  /** 查询当前账号任务列表，可按 sessionId 过滤，默认按 createdAt 倒序。 */
  list(opts?: { sessionId?: string }): Promise<CronJob[]> {
    return this.repo.find({
      where: opts?.sessionId ? { sessionId: opts.sessionId } : {},
      order: { createdAt: "DESC" },
    });
  }

  /** 启动期全量装载（系统级，跨账号）：调度执行器在 boot 无账号上下文时用。 */
  async listAllForBootstrap(): Promise<CronJob[]> {
    // scope-check: allow-unscoped
    return this.repo.unscoped().find({ where: { enabled: true } });
  }

  /** 按 id 查当前账号单条任务，不存在/不属于当前账号抛 NotFoundException。 */
  async findById(id: string): Promise<CronJob> {
    const row = await this.repo.findOneBy({ id });
    if (!row) throw new NotFoundException(`CronJob ${id} 不存在`);
    return row;
  }

  /** 翻转任务启用状态。 */
  async setEnabled(id: string, enabled: boolean): Promise<CronJob> {
    const row = await this.findById(id);
    row.enabled = enabled;
    await this.repo.save(row);
    if (enabled) await this.sink?.register(row);
    else this.sink?.deregister(row.id);
    return row;
  }

  /** 修改任务标题。 */
  async setTitle(id: string, title: string): Promise<CronJob> {
    const row = await this.findById(id);
    row.title = title;
    await this.repo.save(row);
    return row;
  }

  /** 删除单条任务。 */
  async delete(id: string): Promise<void> {
    this.sink?.deregister(id);
    await this.repo.delete({ id });
  }

  /** 删除某 session 下的全部任务。 */
  async deleteBySession(sessionId: string): Promise<void> {
    const rows = await this.repo.find({ where: { sessionId } });
    for (const r of rows) this.sink?.deregister(r.id);
    await this.repo.delete({ sessionId });
  }

  /** 记录触发结果：更新 lastFiredAt、可选 nextFireAt / enabled。 */
  async markFired(
    id: string,
    patch: { lastFiredAt: Date; nextFireAt?: Date | null; enabled?: boolean },
  ): Promise<void> {
    await this.repo.update({ id }, patch);
  }

  /** 按 (id, sessionId) 查；仅返回属于该 session 的行（防越权工具用）。 */
  async findOwnedBy(id: string, sessionId: string): Promise<CronJob | null> {
    const row = await this.repo.findOneBy({ id });
    if (!row || row.sessionId !== sessionId) return null;
    return row;
  }

  /** ScheduleToolsPort 别名：列当前 session 任务。 */
  listBySession(sessionId: string): Promise<CronJob[]> {
    return this.list({ sessionId });
  }
}
