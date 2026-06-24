import {
  type RenameQuickAssistantInput,
  renameQuickAssistantSchema,
} from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import {
  QUICK_ASSISTANT_PORT,
  type QuickAssistantPort,
} from "../quick-assistant.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class RenameQuickAssistantTool
  implements MeshbotTool<RenameQuickAssistantInput, string>
{
  readonly name = "rename_quick_assistant";
  readonly description =
    "Rename the Quick Ask assistant (随手问) — your own name. " +
    "Use when the user asks to change your name. Persists the new name and " +
    "updates the UI in real time. Returns the new name.";
  readonly schema = renameQuickAssistantSchema;

  constructor(
    @Inject(QUICK_ASSISTANT_PORT) private readonly port: QuickAssistantPort,
  ) {}

  /** 给随手问改名并返回新名字。 */
  async execute(
    args: RenameQuickAssistantInput,
    _ctx: ToolContext,
  ): Promise<string> {
    await this.port.rename(args.name);
    return JSON.stringify({ name: args.name });
  }
}
