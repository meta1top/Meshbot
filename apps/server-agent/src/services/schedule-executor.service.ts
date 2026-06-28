import { randomUUID } from "node:crypto";
import { AccountContextService } from "@meshbot/agent";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { SCHEDULE_EVENTS, type ScheduleFiredEvent } from "@meshbot/types-agent";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronExpressionParser } from "cron-parser";
import { CronJob as CronJobLib } from "cron";
import { ACCOUNT_EVENTS } from "../account/account.events";
import type { AccountRuntimeEvent } from "../account/account.events";
import { AccountRuntimeRegistry } from "../account/account-runtime.registry";
import type { CronJob } from "../entities/cron-job.entity";
import { RunnerService } from "./runner.service";
import { ScheduleService } from "./schedule.service";
import { SessionService } from "./session.service";

/** 计划任务调度执行器：bootstrap reload + 单次 fire 投递。 */
@Injectable()
export class ScheduleExecutor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduleExecutor.name);

  /**
   * 每账号已注册到 SchedulerRegistry 的 jobId 集合（cloudUserId → Set<jobId>）。
   * 登出 teardown 时据此反注册该账号全部定时器，避免登出账号残留 cron。
   */
  private readonly accountJobIds = new Map<string, Set<string>>();

  constructor(
    private readonly schedule: ScheduleService,
    private readonly registry: SchedulerRegistry,
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly account: AccountContextService,
    private readonly runtime: AccountRuntimeRegistry,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * 启动时把所有账号的 enabled job 注册到 SchedulerRegistry；过期 once 自动 disable。
   * boot 阶段无账号上下文，故走 listAllForBootstrap（跨账号 unscoped 读），
   * 避免作用域查询因缺上下文抛 NO_ACCOUNT_CONTEXT 致启动失败。
   */
  async onApplicationBootstrap(): Promise<void> {
    this.schedule.setRegistrySink({
      register: (job) => this.register(job),
      deregister: (id) => this.deregister(id),
    });
    const all = await this.schedule.listAllForBootstrap();
    for (const job of all) {
      if (!job.enabled) continue;
      await this.register(job);
    }
  }

  /** 给 ScheduleService 在创建 / 启用时调用，注册一条调度（同时记录账号归属，供登出反注册）。 */
  async register(
    job: Pick<
      CronJob,
      "id" | "kind" | "cronExpr" | "timezone" | "runAt" | "cloudUserId"
    >,
  ): Promise<void> {
    // 幂等：boot 全量装载（onApplicationBootstrap）与账号运行时恢复（onRuntimeCreated）
    // 会并发注册同一 job，已在 SchedulerRegistry 的直接跳过，避免 DUPLICATE_SCHEDULER 崩溃。
    if (
      this.registry.doesExist("cron", job.id) ||
      this.registry.doesExist("timeout", job.id)
    ) {
      return;
    }
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
      this.trackAccountJob(job.cloudUserId, job.id);
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
    this.trackAccountJob(job.cloudUserId, job.id);
  }

  /** 反注册一条调度（kind 不确定时两边都尝试），并从账号归属表移除。 */
  deregister(jobId: string): void {
    if (this.registry.getCronJobs().has(jobId)) {
      this.registry.deleteCronJob(jobId);
    }
    if (this.registry.getTimeouts().includes(jobId)) {
      this.registry.deleteTimeout(jobId);
    }
    this.untrackAccountJob(jobId);
  }

  /** 记录 jobId 归属账号（供登出时批量反注册）。 */
  private trackAccountJob(cloudUserId: string, jobId: string): void {
    let set = this.accountJobIds.get(cloudUserId);
    if (!set) {
      set = new Set<string>();
      this.accountJobIds.set(cloudUserId, set);
    }
    set.add(jobId);
  }

  /** 从所属账号集合移除 jobId（不确定归属哪个账号时遍历移除）。 */
  private untrackAccountJob(jobId: string): void {
    for (const [cloudUserId, set] of this.accountJobIds) {
      if (set.delete(jobId) && set.size === 0) {
        this.accountJobIds.delete(cloudUserId);
      }
    }
  }

  /**
   * 账号运行时创建（登录 / boot 恢复）→ 注册该账号 enabled 任务到 SchedulerRegistry。
   * 幂等：已在 registry 中的 job 跳过（boot 全量装载与本事件可能同时触发，不能重复注册）。
   */
  @OnEvent(ACCOUNT_EVENTS.runtimeCreated)
  async onRuntimeCreated({ cloudUserId }: AccountRuntimeEvent): Promise<void> {
    await this.registerAccountJobs(cloudUserId);
  }

  /** 账号运行时拆除（登出）→ 反注册该账号全部已注册定时器，杜绝登出后残留 cron。 */
  @OnEvent(ACCOUNT_EVENTS.runtimeTeardown)
  onRuntimeTeardown({ cloudUserId }: AccountRuntimeEvent): void {
    this.deregisterAccountJobs(cloudUserId);
  }

  /**
   * 在该账号上下文内列出其 enabled 任务并注册（作用域读，不走 unscoped 旁路）。
   * 幂等由 register() 内部保证（与 boot 全量装载并发时自动跳过已注册的）。
   */
  private async registerAccountJobs(cloudUserId: string): Promise<void> {
    const jobs = await this.account.run(cloudUserId, () =>
      this.schedule.list(),
    );
    for (const job of jobs) {
      if (!job.enabled) continue;
      await this.register(job);
    }
  }

  /** 反注册该账号已记录的全部定时器并清空其集合。 */
  private deregisterAccountJobs(cloudUserId: string): void {
    const ids = this.accountJobIds.get(cloudUserId);
    if (!ids) return;
    // 复制成数组：deregister 会改动 accountJobIds，避免遍历中修改 Set
    for (const jobId of [...ids]) {
      this.deregister(jobId);
    }
    this.accountJobIds.delete(cloudUserId);
  }

  /**
   * 到点触发：在任务归属账号的上下文内投递 user 消息 + kick runner + 更新触发记录。
   *
   * boot 时所有账号的定时器都注册在同一 SchedulerRegistry，timer 回调无账号上下文。
   * 故先用 unscoped 反查任务归属账号（cloudUserId），再在该账号上下文内执行作用域写入。
   * D8：账号未登录（运行时不在线）→ 不跑其 cron，并撤销该定时器。
   */
  async fire(jobId: string): Promise<void> {
    const job = await this.schedule.findByIdUnscoped(jobId);
    if (!job?.enabled) return;
    // D8：账号未登录（运行时不在线）→ 不跑其 cron，并撤销该定时器
    if (!this.runtime.has(job.cloudUserId)) {
      this.deregister(jobId);
      return;
    }
    await this.account.run(job.cloudUserId, async () => {
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
      this.emitter.emit(SCHEDULE_EVENTS.fired, {
        sessionId: job.sessionId,
        jobId: job.id,
        title: session.title,
      } satisfies ScheduleFiredEvent);

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
    });
  }
}
