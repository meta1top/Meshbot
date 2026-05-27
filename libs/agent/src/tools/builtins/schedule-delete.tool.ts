import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  SCHEDULE_TOOLS_PORT,
  type ScheduleToolsPort,
} from "../schedule-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  id: z.string().min(1).describe("Job id to delete."),
});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class ScheduleDeleteTool implements MeshbotTool<Args, string> {
  readonly name = "schedule_delete";
  readonly description =
    "Delete a scheduled task owned by the CURRENT session. " +
    "Returns error if id does not belong to current session.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SCHEDULE_TOOLS_PORT)
    private readonly port: ScheduleToolsPort,
  ) {}

  /** 删除指定任务，越权时返回错误字符串而非抛出异常。 */
  async execute(args: Args, ctx: ToolContext): Promise<string> {
    const job = await this.port.findOwnedBy(args.id, ctx.sessionId);
    if (!job) {
      return `Error: job ${args.id} not found or not owned by this session.`;
    }
    await this.port.delete(args.id);
    return `Deleted ${args.id}.`;
  }
}
