import { SCHEDULE_TOOLS_PORT } from "@meshbot/lib-agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Global, Module } from "@nestjs/common";
import { CronJobController } from "./controllers/cron-job.controller";
import { CronJob } from "./entities/cron-job.entity";
import { ScheduleService } from "./services/schedule.service";

/**
 * 计划任务模块。@Global() 让 SCHEDULE_TOOLS_PORT provider 被任何 module
 * 解析（含 AgentModule 内的 ScheduleCreateTool / List / Delete 三个 tool）。
 *
 * ScheduleExecutor 不在此 module —— 它需要 SessionService + RunnerService，
 * 放在 SessionModule 内更顺。CronJobModule 仅保留 Service + Controller + port。
 */
@Global()
@Module({
  imports: [TxTypeOrmModule.forFeature([CronJob])],
  controllers: [CronJobController],
  providers: [
    ScheduleService,
    {
      provide: SCHEDULE_TOOLS_PORT,
      useFactory: (svc: ScheduleService) => ({
        create: (input: Parameters<ScheduleService["create"]>[0]) =>
          svc
            .create(input)
            .then((j) => ({ id: j.id, nextFireAt: j.nextFireAt })),
        listBySession: (sid: string) => svc.listBySession(sid),
        findOwnedBy: (id: string, sid: string) => svc.findOwnedBy(id, sid),
        delete: (id: string) => svc.delete(id),
      }),
      inject: [ScheduleService],
    },
  ],
  exports: [ScheduleService, SCHEDULE_TOOLS_PORT],
})
export class CronJobModule {}
