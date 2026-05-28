import { z } from "zod";

/** 任务类型：cron 重复 / once 一次性。 */
export const CronJobKindSchema = z.enum(["cron", "once"]);
export type CronJobKind = z.infer<typeof CronJobKindSchema>;

/** POST /api/cron-jobs 入参。 */
export const CreateCronJobSchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().min(1).max(200),
    prompt: z.string().min(1),
    kind: CronJobKindSchema,
    cronExpr: z.string().optional(),
    timezone: z.string().optional(),
    // 接受带 offset 的 ISO 8601（如 '+08:00'）—— Zod 默认 offset:false 只收 Z，
    // 会把合法的本地时区串拒掉，徒增一次重试。下游 new Date() 两种都吃。
    runAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "cron" && !v.cronExpr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cronExpr"],
        message: "kind=cron 必须传 cronExpr",
      });
    }
    if (v.kind === "once" && !v.runAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runAt"],
        message: "kind=once 必须传 runAt",
      });
    }
  });
export type CreateCronJobInput = z.infer<typeof CreateCronJobSchema>;

/** PATCH /api/cron-jobs/:id 入参。 */
export const PatchCronJobSchema = z
  .object({
    enabled: z.boolean().optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .refine((d) => d.enabled !== undefined || d.title !== undefined, {
    message: "至少传 enabled 或 title 之一",
  });
export type PatchCronJobInput = z.infer<typeof PatchCronJobSchema>;

/** 单条 CronJob 对外形态。 */
export const CronJobSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  prompt: z.string(),
  kind: CronJobKindSchema,
  cronExpr: z.string().nullable(),
  timezone: z.string().nullable(),
  runAt: z.string().datetime().nullable(),
  enabled: z.boolean(),
  lastFiredAt: z.string().datetime().nullable(),
  nextFireAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type CronJobDto = z.infer<typeof CronJobSchema>;

/** GET /api/cron-jobs 出参。 */
export const CronJobListResponseSchema = z.object({
  jobs: z.array(CronJobSchema),
});
export type CronJobListResponse = z.infer<typeof CronJobListResponseSchema>;
