import { randomUUID } from "node:crypto";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronExpressionParser } from "cron-parser";
import { CronJob as CronJobLib } from "cron";
import type { CronJob } from "../entities/cron-job.entity";
import { RunnerService } from "./runner.service";
import { ScheduleService } from "./schedule.service";
import { SessionService } from "./session.service";

/** 计划任务调度执行器：bootstrap reload + 单次 fire 投递。 */
@Injectable()
export class ScheduleExecutor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduleExecutor.name);

  constructor(
    private readonly schedule: ScheduleService,
    private readonly registry: SchedulerRegistry,
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
  ) {}

  /** 启动时把所有 enabled job 注册到 SchedulerRegistry；过期 once 自动 disable。 */
  async onApplicationBootstrap(): Promise<void> {
    this.schedule.setRegistrySink({
      register: (job) => this.register(job),
      deregister: (id) => this.deregister(id),
    });
    const all = await this.schedule.list();
    for (const job of all) {
      if (!job.enabled) continue;
      await this.register(job);
    }
  }

  /** 给 ScheduleService 在创建 / 启用时调用，注册一条调度。 */
  async register(
    job: Pick<CronJob, "id" | "kind" | "cronExpr" | "timezone" | "runAt">,
  ): Promise<void> {
    if (job.kind === "cron") {
      const cronJob = new CronJobLib(
        job.cronExpr as string,
        () => {
          void this.fire(job.id).catch((err) =>
            this.logger.error(`fire cron ${job.id} 失败`, err),
          );
        },
        null,
        true,
        job.timezone ?? undefined,
      );
      this.registry.addCronJob(job.id, cronJob);
      return;
    }
    const ms = (job.runAt as Date).getTime() - Date.now();
    if (ms <= 0) {
      // 错过的 one-shot：丢弃 + disable
      await this.schedule
        .setEnabled(job.id, false)
        .catch((err) => this.logger.error(`disable expired ${job.id}`, err));
      return;
    }
    const timeout = setTimeout(() => {
      void this.fire(job.id).catch((err) =>
        this.logger.error(`fire once ${job.id} 失败`, err),
      );
    }, ms);
    this.registry.addTimeout(job.id, timeout);
  }

  /** 反注册一条调度（kind 不确定时两边都尝试）。 */
  deregister(jobId: string): void {
    if (this.registry.getCronJobs().has(jobId)) {
      this.registry.deleteCronJob(jobId);
    }
    if (this.registry.getTimeouts().includes(jobId)) {
      this.registry.deleteTimeout(jobId);
    }
  }

  /** 到点触发：投递 user 消息 + kick runner + 更新触发记录。 */
  async fire(jobId: string): Promise<void> {
    const job = await this.schedule.findById(jobId);
    if (!job.enabled) return;

    const session = await this.sessions.findOrNull(job.sessionId);
    if (!session) {
      this.logger.warn(
        `fire ${jobId}：session ${job.sessionId} 已删，disable 该任务`,
      );
      await this.schedule.setEnabled(jobId, false);
      this.deregister(jobId);
      return;
    }

    await this.sessions.appendMessage(job.sessionId, {
      messageId: randomUUID(),
      content: job.prompt,
    });
    this.runner.kick(job.sessionId);

    if (job.kind === "once") {
      await this.schedule.markFired(jobId, {
        lastFiredAt: new Date(),
        enabled: false,
      });
      this.deregister(jobId);
      return;
    }
    const next = CronExpressionParser.parse(job.cronExpr as string, {
      tz: job.timezone ?? undefined,
    })
      .next()
      .toDate();
    await this.schedule.markFired(jobId, {
      lastFiredAt: new Date(),
      nextFireAt: next,
    });
  }
}
