import {
  type ImListMembersInput,
  imListMembersSchema,
} from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { IM_CONTEXT_PORT, type ImContextPort } from "../im-context.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class ImListMembersTool
  implements MeshbotTool<ImListMembersInput, string>
{
  readonly name = "im_list_members";
  readonly description =
    "List the members of an IM channel by conversationId. " +
    "Use to find out who a colleague is in the current channel.";
  readonly schema = imListMembersSchema;

  constructor(@Inject(IM_CONTEXT_PORT) private readonly port: ImContextPort) {}

  /** 拉频道成员（JSON 字符串）。 */
  execute(args: ImListMembersInput, _ctx: ToolContext): Promise<string> {
    return this.port.listMembers(args.conversationId);
  }
}
