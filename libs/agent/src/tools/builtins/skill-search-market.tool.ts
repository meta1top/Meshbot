import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { SKILL_TOOLS_PORT, type SkillToolsPort } from "../skill-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  source: z.enum(["ourMarket", "github", "clawhub"]),
  query: z.string().optional().describe("Keyword to search; omit to browse"),
});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class SkillSearchMarketTool implements MeshbotTool<Args, string> {
  readonly name = "skill_search_market";
  readonly description =
    "Search / browse installable skills in a marketplace (ourMarket or clawhub). " +
    "github has no search endpoint and returns an empty list (install github skills " +
    "directly via skill_install with owner/repo). Returns a JSON array of skills " +
    "(slug, displayName, description, author, latestVersion).";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SKILL_TOOLS_PORT) private readonly port: SkillToolsPort,
  ) {}

  /** 搜索/浏览市场技能并返回 JSON 列表。 */
  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    const list = await this.port.searchMarket(args.source, args.query);
    return JSON.stringify(list);
  }
}
