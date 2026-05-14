#!/usr/bin/env tsx
/**
 * sync-skills —— 把 .cursor/rules/*.mdc 派生为 .claude/skills/<name>/SKILL.md。
 *
 * Cursor mdc frontmatter:                Claude SKILL.md frontmatter:
 *   description, globs?, alwaysApply?     name: <slug>
 *                                         description: <mdc desc> [Use when matching: <globs>]
 *
 * body 完全 1:1 拷过去。
 *
 * 用法：
 *   pnpm sync:skills              # 全量同步
 *   pnpm sync:skills -- --check   # 仅比对；不一致 exit 1（pre-commit 用）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const RULES_DIR = path.join(ROOT, ".cursor", "rules");
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");

interface Frontmatter {
  description?: string;
  globs?: string | string[];
  alwaysApply?: boolean;
}

function parseMdc(content: string): { fm: Frontmatter; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");

  const fmRaw = m[1];
  const body = m[2].replace(/^\n+/, "");
  const fm: Frontmatter = {};

  const lines = fmRaw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (key === "globs") {
      // Three syntactic forms:
      //   globs: foo,bar,baz
      //   globs: "foo,bar"
      //   globs:
      //     - foo
      //     - bar
      if (rest === "") {
        // Block-style list — gather next lines starting with "  - " or "- "
        const list: string[] = [];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          const trimmed = next.trim();
          if (trimmed.startsWith("- ")) {
            list.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ""));
            i++;
          } else if (trimmed === "") {
            i++;
          } else {
            break;
          }
        }
        fm.globs = list;
        continue;
      } else {
        // Inline string or list
        const v = rest.replace(/^["']|["']$/g, "");
        fm.globs = v;
        i++;
        continue;
      }
    } else if (key === "description") {
      // Description may span multiple lines as YAML block, or single line
      // Simplest: take everything after `:` until next `key:` line
      let desc = rest;
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (/^\w[\w-]*:/.test(next.trimStart()) && !next.startsWith(" ")) break;
        desc += " " + next.trim();
        i++;
      }
      fm.description = desc.replace(/\s+/g, " ").trim();
      continue;
    } else if (key === "alwaysApply") {
      fm.alwaysApply = rest === "true";
      i++;
      continue;
    } else {
      i++;
    }
  }
  return { fm, body };
}

function buildSkillFrontmatter(slug: string, fm: Frontmatter): string {
  const desc = fm.description || "";
  const globsStr = Array.isArray(fm.globs) ? fm.globs.join(", ") : fm.globs;
  const trigger = globsStr
    ? ` Use when files matching ${globsStr} change, or when explicitly invoked.`
    : fm.alwaysApply
      ? " Apply to all relevant work in this repo."
      : "";

  // JSON-stringify to handle embedded quotes/newlines safely
  return `---
name: ${slug}
description: ${JSON.stringify(desc + trigger)}
---`;
}

function generate(): { slug: string; skillContent: string }[] {
  if (!fs.existsSync(RULES_DIR)) {
    console.error(`No rules dir: ${RULES_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(RULES_DIR).filter((f) => f.endsWith(".mdc"));
  return files.map((file) => {
    const slug = file.replace(/\.mdc$/, "");
    const mdcContent = fs.readFileSync(path.join(RULES_DIR, file), "utf-8");
    const { fm, body } = parseMdc(mdcContent);
    const fmOut = buildSkillFrontmatter(slug, fm);
    const skillContent = `${fmOut}\n\n${body}\n`;
    return { slug, skillContent };
  });
}

const check = process.argv.includes("--check");
let drift = 0;
const generated = generate();
const generatedSlugs = new Set(generated.map((g) => g.slug));

// Detect orphaned SKILL.md (skill exists with no source mdc)
if (fs.existsSync(SKILLS_DIR)) {
  const skillDirs = fs.readdirSync(SKILLS_DIR);
  for (const dir of skillDirs) {
    const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (fs.existsSync(skillFile) && !generatedSlugs.has(dir)) {
      console.warn(`[orphan] .claude/skills/${dir}/SKILL.md has no .cursor/rules/${dir}.mdc source`);
      drift++;
    }
  }
}

for (const { slug, skillContent } of generated) {
  const target = path.join(SKILLS_DIR, slug, "SKILL.md");
  if (check) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "";
    if (existing !== skillContent) {
      console.error(`[drift] .claude/skills/${slug}/SKILL.md differs from .cursor/rules/${slug}.mdc`);
      drift++;
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, skillContent, "utf-8");
    console.log(`wrote: .claude/skills/${slug}/SKILL.md`);
  }
}

if (check && drift > 0) {
  console.error(`\n${drift} skill file(s) out of sync; run \`pnpm sync:skills\` to fix`);
  process.exit(1);
}
if (!check) console.log(`Done (${generated.length} skills synced)`);
process.exit(0);
