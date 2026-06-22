import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { SKILL_TOOLS_PORT, type SkillToolsPort } from "../skill-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("The installed skill directory name to remove"),
});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class SkillUninstallTool implements MeshbotTool<Args, string> {
  readonly name = "skill_uninstall";
  readonly description =
    "Uninstall (remove) an installed skill by its name. Idempotent — removing a " +
    "non-existent skill is a no-op. Use skill_list to see installed skill names.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SKILL_TOOLS_PORT) private readonly port: SkillToolsPort,
  ) {}

  /** 卸载技能。 */
  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    await this.port.uninstall(args.name);
    return `Uninstalled skill "${args.name}".`;
  }
}
