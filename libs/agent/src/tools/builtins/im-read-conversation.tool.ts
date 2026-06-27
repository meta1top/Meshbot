import {
  type ImReadConversationInput,
  imReadConversationSchema,
} from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { IM_CONTEXT_PORT, type ImContextPort } from "../im-context.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class ImReadConversationTool
  implements MeshbotTool<ImReadConversationInput, string>
{
  readonly name = "im_read_conversation";
  readonly description =
    "Read recent messages of a specific IM channel or DM by conversationId " +
    "(the `id` shown in the <llmuse> context or page URL). " +
    "Optional `limit` (max 100) and `before` (message-id cursor for older pages).";
  readonly schema = imReadConversationSchema;

  constructor(@Inject(IM_CONTEXT_PORT) private readonly port: ImContextPort) {}

  /** 拉某会话历史消息（JSON 字符串）。 */
  execute(args: ImReadConversationInput, _ctx: ToolContext): Promise<string> {
    return this.port.readConversation(args.conversationId, {
      limit: args.limit,
      before: args.before,
    });
  }
}
