import { z } from "zod";

/** server-agent 本地事件：定时任务触发。 */
export const SCHEDULE_EVENTS = {
  fired: "schedule.fired",
} as const;

export const ScheduleFiredEventSchema = z.object({
  sessionId: z.string(),
  jobId: z.string(),
  title: z.string(),
});

export type ScheduleFiredEvent = z.infer<typeof ScheduleFiredEventSchema>;
