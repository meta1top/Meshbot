import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import type { SkillContent, SkillEntry } from "./skill.types";

/** 合法 skill 名字白名单（防路径穿越）。 */
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** 简易 frontmatter（仅取 name / description）。完整 YAML 不需要。 */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * SkillService —— 扫描 `<meshbotDir>/skills/<name>/SKILL.md`：
 * - `list()` 返回所有 skill 的 `{name, description}`（轻量，给 LLM 渐进式发现用）
 * - `load(name)` 返回完整 SKILL.md 正文（含 frontmatter）；如有依赖文件由 LLM 后续自取
 *
 * 每次调用都重新扫描磁盘，无缓存：skills 数量通常很小，且支持热更新最简单。
 */
@Injectable()
export class SkillService {
  constructor(private readonly config: MeshbotConfigService) {}

  /** 扫描 skills 目录，返回所有 skill 的轻量元信息。 */
  list(): SkillEntry[] {
    const skillsDir = this.config.getSkillsDir();
    if (!existsSync(skillsDir)) {
      return [];
    }
    const entries: SkillEntry[] = [];
    for (const name of readdirSync(skillsDir)) {
      if (!SKILL_NAME_RE.test(name)) continue;
      const dir = path.join(skillsDir, name);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const skillFile = path.join(dir, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const raw = readFileSync(skillFile, "utf8");
      const fm = parseFrontmatter(raw);
      // frontmatter.name 与目录名不一致时，以目录名为准（避免重复 / 引用混乱）。
      entries.push({
        name,
        description: fm.description ?? "",
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /** 加载单个 skill 的完整 SKILL.md。找不到返 null。 */
  load(name: string): SkillContent | null {
    if (!SKILL_NAME_RE.test(name)) {
      return null;
    }
    const dir = path.join(this.config.getSkillsDir(), name);
    const skillFile = path.join(dir, "SKILL.md");
    if (!existsSync(skillFile)) {
      return null;
    }
    const content = readFileSync(skillFile, "utf8");
    const fm = parseFrontmatter(content);
    return {
      name,
      description: fm.description ?? "",
      content,
      dir,
    };
  }
}

/** 从 SKILL.md 头部取 `name` / `description` 两个字段（容错地）。 */
function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
} {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return {};
  const block = m[1];
  const result: { name?: string; description?: string } = {};
  // 逐行解析 key: value；支持 "..." / '...' 包裹的值。
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (key !== "name" && key !== "description") continue;
    // 处理 YAML 块标量 `>` / `|`：拼接后续缩进行。
    if (value === ">" || value === "|") {
      const folded = value === ">";
      const collected: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        collected.push(lines[++i].replace(/^\s+/, ""));
      }
      value = folded ? collected.join(" ") : collected.join("\n");
    } else {
      value = stripQuotes(value);
    }
    result[key] = value;
  }
  return result;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}
