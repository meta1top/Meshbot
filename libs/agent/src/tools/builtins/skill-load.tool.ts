import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { SkillService } from "../../skills/skill.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const SkillLoadArgsSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Skill name (the directory name under <meshbotDir>/skills/). " +
        "Get it from skill_list first.",
    ),
});
type SkillLoadArgs = z.infer<typeof SkillLoadArgsSchema>;

/**
 * skill_load —— 返回指定 skill 的完整 SKILL.md（含 frontmatter 与正文）。
 * 若 SKILL.md 中引用了其他文件（如 references/foo.md）或网络资源，由 LLM
 * 后续自行用 read_file / web_fetch 等工具按需拉取（渐进式加载）。
 */
@Injectable()
@Tool()
export class SkillLoadTool implements MeshbotTool<SkillLoadArgs, string> {
  readonly name = "skill_load";
  readonly description =
    "Load the full SKILL.md content of a single skill by name. " +
    "Returns the raw markdown (including frontmatter). " +
    "If the skill references other local files or URLs, fetch them on demand " +
    "using read_file / web_fetch — this tool does NOT auto-resolve dependencies.";
  readonly schema = SkillLoadArgsSchema;

  constructor(private readonly skills: SkillService) {}

  async execute(args: SkillLoadArgs, _ctx: ToolContext): Promise<string> {
    const r = this.skills.load(args.name);
    if (!r) {
      return `Error: skill "${args.name}" not found. Call skill_list to see available skills.`;
    }
    // 在正文前追加一行 skill 目录绝对路径，便于 LLM 拼接相对引用文件。
    return `[skill dir] ${r.dir}\n\n${r.content}`;
  }
}
