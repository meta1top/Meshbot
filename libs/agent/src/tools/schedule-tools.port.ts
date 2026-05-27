import type { CronJobDto, CreateCronJobInput } from "@meshbot/types-agent";

/** libs/agent → apps/server-agent 解耦的注入边界。
 *
 * apps/server-agent 在模块中提供 `{ provide: SCHEDULE_TOOLS_PORT, useExisting: ScheduleService }`。
 */
export const SCHEDULE_TOOLS_PORT = Symbol("SCHEDULE_TOOLS_PORT");

export interface ScheduleToolsPort {
  create(
    input: CreateCronJobInput,
  ): Promise<{ id: string; nextFireAt: Date | null }>;
  listBySession(sessionId: string): Promise<CronJobDto[]>;
  findOwnedBy(id: string, sessionId: string): Promise<CronJobDto | null>;
  delete(id: string): Promise<void>;
}
