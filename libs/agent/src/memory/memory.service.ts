import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { generateSnowflakeId } from "@meshbot/common";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import type { MemoryEntry } from "./memory.types";

/** core.md 最大允许字节数（Buffer.byteLength，UTF-8）。 */
const CORE_MAX_BYTES = 2048;

/** 合法归档 id（纯数字雪花，防路径穿越）。 */
const SNOWFLAKE_ID_RE = /^\d+$/;

/**
 * frontmatter 正则：匹配 `---\n<block>\n---\n<body>` 格式。
 * 仿 skill.service 的 FRONTMATTER_RE。
 */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * MemoryService —— 分层文件记忆存储。
 *
 * - core.md：核心记忆（单文件，2 KB 上限，注入系统提示）
 * - archive/<id>.md：归档记忆（frontmatter + 正文，雪花 id，支持关键词检索）
 *
 * 所有路径经 MeshbotConfigService.getMemoryDir()，自动按账号隔离。
 */
@Injectable()
export class MemoryService {
  constructor(private readonly config: MeshbotConfigService) {}

  /**
   * 读取 core.md 内容。文件不存在时返回空字符串。
   */
  readCore(): string {
    const corePath = this.corePath();
    if (!existsSync(corePath)) {
      return "";
    }
    return readFileSync(corePath, "utf8");
  }

  /**
   * 写入 core.md。超过 CORE_MAX_BYTES（2048 字节）时抛错。
   */
  writeCore(content: string): void {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > CORE_MAX_BYTES) {
      throw new Error(
        `core.md 超限：${bytes} 字节 > ${CORE_MAX_BYTES} 字节上限。请精简内容后重试。`,
      );
    }
    const memDir = this.config.getMemoryDir();
    mkdirSync(memDir, { recursive: true });
    writeFileSync(this.corePath(), content, "utf8");
  }

  /**
   * 新增归档记忆条目。
   * 自动分配雪花 id，写入 archive/<id>.md（frontmatter + 正文）。
   */
  add(input: {
    content: string;
    title?: string;
    tags?: string[];
  }): MemoryEntry {
    const id = generateSnowflakeId();
    const title = input.title ?? "";
    const tags = input.tags ?? [];
    const createdAt = new Date().toISOString();

    const entry: MemoryEntry = {
      id,
      title,
      tags,
      createdAt,
      content: input.content,
    };

    const archiveDir = this.archiveDir();
    mkdirSync(archiveDir, { recursive: true });

    const raw = serializeEntry(entry);
    writeFileSync(path.join(archiveDir, `${id}.md`), raw, "utf8");

    return entry;
  }

  /**
   * 检索归档记忆。
   * - query 非空：在 title / tags / content 中大小写不敏感匹配，按 createdAt desc 排序。
   * - query 为空：返回最近 limit 条。
   * - limit 默认 20。
   */
  search(query?: string, limit = 20): MemoryEntry[] {
    const archiveDir = this.archiveDir();
    if (!existsSync(archiveDir)) {
      return [];
    }

    const files = readdirSync(archiveDir).filter(
      (f) => f.endsWith(".md") && SNOWFLAKE_ID_RE.test(f.slice(0, -3)),
    );

    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const raw = readFileSync(path.join(archiveDir, file), "utf8");
      const entry = parseEntry(raw);
      if (entry) {
        entries.push(entry);
      }
    }

    // 按 createdAt desc 排序（ISO 字符串字典序与时间序一致）；
    // 时间相同时用雪花 id（单调递增数字字符串）作辅助排序，保证确定性。
    entries.sort((a, b) => {
      const timeDiff = b.createdAt.localeCompare(a.createdAt);
      if (timeDiff !== 0) return timeDiff;
      // 雪花 id 是纯数字字符串，用 BigInt 比较保证正确的数字序
      return b.id.localeCompare(a.id, undefined, { numeric: true });
    });

    if (!query || query.trim() === "") {
      return entries.slice(0, limit);
    }

    const q = query.toLowerCase();
    const matched = entries.filter((e) => {
      if (e.title.toLowerCase().includes(q)) return true;
      if (e.tags.some((t) => t.toLowerCase().includes(q))) return true;
      if (e.content.toLowerCase().includes(q)) return true;
      return false;
    });

    return matched.slice(0, limit);
  }

  /**
   * 删除归档记忆条目（幂等，不存在时不抛错）。
   */
  delete(id: string): void {
    if (!SNOWFLAKE_ID_RE.test(id)) {
      // 非法 id，静默忽略（防路径穿越）
      return;
    }
    const file = path.join(this.archiveDir(), `${id}.md`);
    if (!existsSync(file)) {
      return;
    }
    rmSync(file);
  }

  // ---------------------------------------------------------------- private --

  private corePath(): string {
    return path.join(this.config.getMemoryDir(), "core.md");
  }

  private archiveDir(): string {
    return path.join(this.config.getMemoryDir(), "archive");
  }
}

// ---------------------------------------------------------------- helpers --

/**
 * 序列化 MemoryEntry 为 frontmatter + 正文格式（仿 skill.service 风格）。
 * title 不加引号（不含特殊字符时）；tags 用 JSON 字符串数组。
 */
function serializeEntry(entry: MemoryEntry): string {
  const tagsYaml = `[${entry.tags.map((t) => JSON.stringify(t)).join(", ")}]`;
  const fm = [
    "---",
    `id: ${entry.id}`,
    `title: ${entry.title}`,
    `tags: ${tagsYaml}`,
    `createdAt: ${entry.createdAt}`,
    "---",
    "",
    entry.content,
  ].join("\n");
  return fm;
}

/**
 * 从 frontmatter + 正文格式解析 MemoryEntry。解析失败返 null。
 */
function parseEntry(raw: string): MemoryEntry | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;

  const block = m[1];
  const content = m[2].trim();

  const parsed: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    parsed[kv[1]] = kv[2].trim();
  }

  const id = parsed.id;
  if (!id || !SNOWFLAKE_ID_RE.test(id)) return null;

  // title 可以带或不带 JSON 引号（兼容两种序列化格式）
  const rawTitle = parsed.title ?? "";
  const title = rawTitle.startsWith('"') ? stripJsonString(rawTitle) : rawTitle;
  const createdAt = parsed.createdAt ?? "";

  // 解析 tags 数组：[\"tag1\", \"tag2\"] 格式
  let tags: string[] = [];
  const tagsRaw = parsed.tags ?? "[]";
  const tagsMatch = tagsRaw.match(/^\[(.*)\]$/s);
  if (tagsMatch) {
    const inner = tagsMatch[1].trim();
    if (inner) {
      // 拆分 JSON 字符串数组
      try {
        tags = JSON.parse(`[${inner}]`) as string[];
      } catch {
        tags = [];
      }
    }
  }

  return { id, title, tags, createdAt, content };
}

function stripJsonString(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
