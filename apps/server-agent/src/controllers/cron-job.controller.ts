import {
  CreateCronJobSchema,
  type CronJobDto,
  type CronJobListResponse,
  PatchCronJobSchema,
} from "@meshbot/types-agent";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { CreateCronJobDto, PatchCronJobDto } from "../dto/cron-job.dto";
import type { CronJob } from "../entities/cron-job.entity";
import { ScheduleService } from "../services/schedule.service";

function toDto(job: CronJob): CronJobDto {
  return {
    id: job.id,
    sessionId: job.sessionId,
    title: job.title,
    prompt: job.prompt,
    kind: job.kind,
    cronExpr: job.cronExpr,
    timezone: job.timezone,
    runAt: job.runAt ? job.runAt.toISOString() : null,
    enabled: job.enabled,
    lastFiredAt: job.lastFiredAt ? job.lastFiredAt.toISOString() : null,
    nextFireAt: job.nextFireAt ? job.nextFireAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
  };
}

/** 计划任务 REST 端点。瘦 Controller —— 业务在 ScheduleService。 */
@Controller("api/cron-jobs")
export class CronJobController {
  constructor(private readonly schedule: ScheduleService) {}

  /** 列表：无参 = 全部；?sessionId=xxx 过滤。 */
  @Get()
  async list(
    @Query("sessionId") sessionId?: string,
  ): Promise<CronJobListResponse> {
    const jobs = await this.schedule.list(
      sessionId ? { sessionId } : undefined,
    );
    return { jobs: jobs.map(toDto) };
  }

  @Post()
  async create(@Body() body: CreateCronJobDto): Promise<CronJobDto> {
    const input = CreateCronJobSchema.parse(body);
    const job = await this.schedule.create(input);
    return toDto(job);
  }

  @Patch(":id")
  async patch(
    @Param("id") id: string,
    @Body() body: PatchCronJobDto,
  ): Promise<CronJobDto> {
    const input = PatchCronJobSchema.parse(body);
    if (input.enabled !== undefined) {
      await this.schedule.setEnabled(id, input.enabled);
    }
    if (input.title !== undefined) {
      await this.schedule.setTitle(id, input.title);
    }
    const job = await this.schedule.findById(id);
    return toDto(job);
  }

  @Delete(":id")
  async remove(@Param("id") id: string): Promise<{ deleted: true }> {
    await this.schedule.delete(id);
    return { deleted: true };
  }
}
