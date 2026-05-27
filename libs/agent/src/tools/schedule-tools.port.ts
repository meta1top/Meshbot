import type { CreateCronJobInput } from "@meshbot/types-agent";

/** libs/agent → apps/server-agent 解耦的注入边界。
 *
 * apps/server-agent 在 session.module 用 useFactory adapter 提供实现。
 */
export const SCHEDULE_TOOLS_PORT = Symbol("SCHEDULE_TOOLS_PORT");

/** 工具对外可见的最小投影（Tool 序列化用）。
 * Date / ISO string 都接受 —— Tool 只做 JSON.stringify 给 LLM 看。 */
export interface ScheduleJobView {
  id: string;
  title: string;
  kind: "cron" | "once";
  cronExpr: string | null;
  runAt: Date | string | null;
  enabled: boolean;
  nextFireAt: Date | string | null;
  lastFiredAt: Date | string | null;
}

export interface ScheduleToolsPort {
  create(
    input: CreateCronJobInput,
  ): Promise<{ id: string; nextFireAt: Date | null }>;
  listBySession(sessionId: string): Promise<ScheduleJobView[]>;
  findOwnedBy(id: string, sessionId: string): Promise<ScheduleJobView | null>;
  delete(id: string): Promise<void>;
}
