import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { SkillService } from "../../skills/skill.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const SkillListArgsSchema = z.object({}).strict();
type SkillListArgs = z.infer<typeof SkillListArgsSchema>;

/**
 * skill_list —— 列出 `<meshbotDir>/skills/` 下所有 skill 的轻量元信息。
 * 返回 JSON `[{name, description}]`；LLM 根据 description 判断哪个相关，
 * 再用 skill_load 拉完整 SKILL.md（渐进式加载，避免一次性塞爆上下文）。
 */
@Injectable()
@Tool()
export class SkillListTool implements MeshbotTool<SkillListArgs, string> {
  readonly name = "skill_list";
  readonly description =
    "List all available skills with their name and short description. " +
    "Returns a JSON array of {name, description}. " +
    "Use this first to discover skills, then call skill_load with a chosen name " +
    "to fetch the full SKILL.md content.";
  readonly schema = SkillListArgsSchema;

  constructor(private readonly skills: SkillService) {}

  async execute(_args: SkillListArgs, _ctx: ToolContext): Promise<string> {
    const list = this.skills.list();
    return JSON.stringify(list, null, 2);
  }
}
