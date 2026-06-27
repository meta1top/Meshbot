import {
  type ImSendMessageInput,
  imSendMessageSchema,
} from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { IM_SEND_PORT, type ImSendPort } from "../im-send.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class ImSendMessageTool
  implements MeshbotTool<ImSendMessageInput, string>
{
  readonly name = "im_send_message";
  readonly description =
    "Send a message to an IM channel or DM by conversationId (e.g. the one in the " +
    "<llmuse> context). The message is shown to the user for confirmation before it is " +
    "actually delivered, and they may edit it. Call ONLY when the user explicitly asks " +
    "to send/reply. Returns a JSON status: sent | cancelled | timeout | interrupted | error.";
  readonly schema = imSendMessageSchema;

  constructor(@Inject(IM_SEND_PORT) private readonly port: ImSendPort) {}

  /** 请求用户确认并发送消息；返回 {status} JSON 字符串。 */
  execute(args: ImSendMessageInput, ctx: ToolContext): Promise<string> {
    return this.port.confirmAndSend(
      {
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        conversationId: args.conversationId,
        content: args.content,
      },
      ctx.signal,
    );
  }
}
