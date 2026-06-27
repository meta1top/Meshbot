import { type AskQuestionInput, askQuestionSchema } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { ASK_QUESTION_PORT, type AskQuestionPort } from "../ask-question.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class AskQuestionTool implements MeshbotTool<AskQuestionInput, string> {
  readonly name = "ask_question";
  readonly description =
    "Ask the user to choose among explicit options when you genuinely need their " +
    "decision. Provide 1-4 questions, each with clear option labels (and optional " +
    "description), single- or multi-select. An 'other' free-text input is always added. " +
    "The call blocks until the user submits. Do NOT use for things you can decide " +
    "yourself or single-fact lookups. Returns JSON: status answered (with answers) / " +
    "timeout / interrupted.";
  readonly schema = askQuestionSchema;

  constructor(
    @Inject(ASK_QUESTION_PORT) private readonly port: AskQuestionPort,
  ) {}

  /** 弹问题卡、挂起等用户提交；返回 {status, answers} JSON 字符串。 */
  execute(_args: AskQuestionInput, ctx: ToolContext): Promise<string> {
    return this.port.ask(
      { sessionId: ctx.sessionId, toolCallId: ctx.toolCallId },
      ctx.signal,
    );
  }
}
