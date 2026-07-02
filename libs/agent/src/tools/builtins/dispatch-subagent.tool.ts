import { dispatchSubagentSchema } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import {
  DISPATCH_SUBAGENT_PORT,
  type DispatchSubagentPort,
} from "../dispatch-subagent.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

/** dispatch_subagent 工具入参（使用 schema input 类型，兼容 ZodDefault）。 */
type DispatchSubagentArgs = z.input<typeof dispatchSubagentSchema>;

@Injectable()
@Tool()
export class DispatchSubagentTool
  implements MeshbotTool<DispatchSubagentArgs, string>
{
  readonly name = "dispatch_subagent";
  readonly description =
    "Delegate a self-contained sub-task to a fresh, context-isolated sub-agent. " +
    "The sub-agent has the same tools but starts from a clean context with only your " +
    "`task` prompt, runs to completion, and returns a JSON result {subSessionId,status,output}. " +
    "Use to decompose large tasks or keep your own context clean. You may call it multiple " +
    "times in one turn to run sub-agents in parallel. Sub-agents cannot dispatch further.";
  readonly schema = dispatchSubagentSchema;

  constructor(
    @Inject(DISPATCH_SUBAGENT_PORT) private readonly port: DispatchSubagentPort,
  ) {}

  /** 把子任务委派给子 Agent；前台阻塞至完成，返回 {subSessionId,status,output} JSON。 */
  execute(args: DispatchSubagentArgs, ctx: ToolContext): Promise<string> {
    return this.port.dispatch(
      {
        parentSessionId: ctx.sessionId,
        parentToolCallId: ctx.toolCallId,
        task: args.task,
        description: args.description,
        model: args.model,
        background: args.background,
      },
      ctx.signal,
    );
  }
}
