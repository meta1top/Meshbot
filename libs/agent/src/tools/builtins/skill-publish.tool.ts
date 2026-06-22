import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { SKILL_TOOLS_PORT, type SkillToolsPort } from "../skill-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("The local installed skill directory name to publish"),
  slug: z.string().min(1).describe("Marketplace slug (lowercase, a-z0-9-)"),
  displayName: z.string().min(1),
  version: z.string().min(1),
  changelog: z.string().optional(),
});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class SkillPublishTool implements MeshbotTool<Args, string> {
  readonly name = "skill_publish";
  readonly description =
    "Publish a local installed skill to our cloud marketplace (so others in the org " +
    "can discover and install it). Packages the skill directory and uploads it under " +
    "the given slug + version. Returns a confirmation.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SKILL_TOOLS_PORT) private readonly port: SkillToolsPort,
  ) {}

  /** 发布本地技能到云端市场。 */
  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    await this.port.publish(args);
    return `Published "${args.slug}@${args.version}" to the marketplace.`;
  }
}
