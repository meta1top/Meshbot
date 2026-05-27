import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  SCHEDULE_TOOLS_PORT,
  type ScheduleToolsPort,
} from "../schedule-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(["cron", "once"]),
  cronExpr: z
    .string()
    .optional()
    .describe(
      "5-field cron expression (m h dom mon dow). REQUIRED when kind='cron'.",
    ),
  runAt: z
    .string()
    .datetime()
    .optional()
    .describe("ISO 8601 datetime. REQUIRED when kind='once'."),
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone for cron schedule. Defaults to server OS timezone.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe(
      "The user message that will be delivered to this session when the job fires.",
    ),
});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class ScheduleCreateTool implements MeshbotTool<Args, string> {
  readonly name = "schedule_create";
  readonly description =
    "Create a scheduled task (cron repeat or one-shot) bound to the CURRENT session. " +
    "When kind='cron', cronExpr is REQUIRED. When kind='once', runAt is REQUIRED. " +
    "Returns job id + next fire time.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SCHEDULE_TOOLS_PORT)
    private readonly port: ScheduleToolsPort,
  ) {}

  /** 创建定时任务并返回 job id 与下次触发时间。 */
  async execute(args: Args, ctx: ToolContext): Promise<string> {
    const tz =
      args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { id, nextFireAt } = await this.port.create({
      sessionId: ctx.sessionId,
      title: args.title,
      prompt: args.prompt,
      kind: args.kind,
      cronExpr: args.cronExpr,
      timezone: args.kind === "cron" ? tz : undefined,
      runAt: args.runAt,
    });
    return `Created scheduled job ${id}. Next fire: ${nextFireAt?.toISOString() ?? "n/a"}.`;
  }
}
