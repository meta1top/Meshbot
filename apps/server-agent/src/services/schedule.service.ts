import { randomUUID } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { CronExpressionParser } from "cron-parser";
import { Repository } from "typeorm";
import type { CreateCronJobInput } from "@meshbot/types-agent";
import { CronJob } from "../entities/cron-job.entity";

/** ScheduleService CRUD —— SchedulerRegistry 同步在 ScheduleExecutor 接入。 */
@Injectable()
export class ScheduleService {
  constructor(
    @InjectRepository(CronJob)
    private readonly repo: Repository<CronJob>,
  ) {}

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

  /** 新增计划任务，自动计算 nextFireAt。 */
  async create(input: CreateCronJobInput): Promise<CronJob> {
    const id = randomUUID();
    const nextFireAt = ScheduleService.computeNextFireAt(input);
    const entity = this.repo.create({
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
    });
    await this.repo.save(entity);
    return entity;
  }

  /** 查询任务列表，可按 sessionId 过滤，默认按 createdAt 倒序。 */
  list(opts?: { sessionId?: string }): Promise<CronJob[]> {
    return this.repo.find({
      where: opts?.sessionId ? { sessionId: opts.sessionId } : {},
      order: { createdAt: "DESC" },
    });
  }

  /** 按 id 查单条任务，不存在抛 NotFoundException。 */
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
    await this.repo.delete({ id });
  }

  /** 删除某 session 下的全部任务。 */
  async deleteBySession(sessionId: string): Promise<void> {
    await this.repo.delete({ sessionId });
  }

  /** 记录触发结果：更新 lastFiredAt、可选 nextFireAt / enabled。 */
  async markFired(
    id: string,
    patch: { lastFiredAt: Date; nextFireAt?: Date | null; enabled?: boolean },
  ): Promise<void> {
    await this.repo.update({ id }, patch);
  }
}
