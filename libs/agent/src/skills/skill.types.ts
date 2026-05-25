/** SKILL.md frontmatter 解析结果 + 完整正文。 */
export interface SkillEntry {
  /** kebab-case 名字，等于目录名，亦应等于 frontmatter 中的 name。 */
  name: string;
  /** frontmatter description；用于 skill_list 列表展示。 */
  description: string;
}

/** 完整 skill 内容（含原始 SKILL.md 全文，含 frontmatter）。 */
export interface SkillContent extends SkillEntry {
  /** SKILL.md 完整文本（含 frontmatter 与正文）。 */
  content: string;
  /** SKILL.md 所在目录的绝对路径，便于上层拼接相对引用文件。 */
  dir: string;
}
