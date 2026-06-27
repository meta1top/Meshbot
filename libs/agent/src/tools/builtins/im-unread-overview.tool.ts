import { imUnreadOverviewSchema } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { IM_CONTEXT_PORT, type ImContextPort } from "../im-context.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class ImUnreadOverviewTool
  implements MeshbotTool<Record<string, never>, string>
{
  readonly name = "im_unread_overview";
  readonly description =
    "List all the user's IM conversations (channels + DMs) with their unread counts. " +
    "Use when the user asks what is unhandled / how many unread messages they have.";
  readonly schema = imUnreadOverviewSchema;

  constructor(@Inject(IM_CONTEXT_PORT) private readonly port: ImContextPort) {}

  /** 返回所有会话 + 未读概览（JSON 字符串）。 */
  execute(_args: Record<string, never>, _ctx: ToolContext): Promise<string> {
    return this.port.unreadOverview();
  }
}
