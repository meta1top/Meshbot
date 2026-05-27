import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  SCHEDULE_TOOLS_PORT,
  type ScheduleToolsPort,
} from "../schedule-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class ScheduleListTool implements MeshbotTool<Args, string> {
  readonly name = "schedule_list";
  readonly description =
    "List scheduled tasks owned by the CURRENT session. " +
    "Cannot see tasks from other sessions.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SCHEDULE_TOOLS_PORT)
    private readonly port: ScheduleToolsPort,
  ) {}

  /** 列出当前 session 的所有定时任务。 */
  async execute(_args: Args, ctx: ToolContext): Promise<string> {
    const jobs = await this.port.listBySession(ctx.sessionId);
    if (jobs.length === 0) return "No scheduled tasks in this session.";
    return JSON.stringify(
      jobs.map((j) => ({
        id: j.id,
        title: j.title,
        kind: j.kind,
        cronExpr: j.cronExpr,
        runAt: j.runAt,
        enabled: j.enabled,
        nextFireAt: j.nextFireAt,
        lastFiredAt: j.lastFiredAt,
      })),
      null,
      2,
    );
  }
}
