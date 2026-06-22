import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { SKILL_TOOLS_PORT, type SkillToolsPort } from "../skill-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  source: z.enum(["ourMarket", "github", "clawhub"]),
  ref: z
    .string()
    .min(1)
    .describe(
      "ourMarket/clawhub use the skill slug; github uses owner/repo[@ref]",
    ),
  version: z.string().optional(),
});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class SkillInstallTool implements MeshbotTool<Args, string> {
  readonly name = "skill_install";
  readonly description =
    "Install a skill from ourMarket / GitHub / clawhub into the local skills directory. " +
    "Hot-loaded — immediately usable via skill_list / skill_load afterward. " +
    "ref: ourMarket/clawhub use the slug; github uses owner/repo[@ref]. " +
    "Returns the installed skill name + description.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SKILL_TOOLS_PORT) private readonly port: SkillToolsPort,
  ) {}

  /** 安装技能并返回已装技能信息。 */
  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    const installed = await this.port.install(args);
    return JSON.stringify(installed);
  }
}
