import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import type { PromptFileMeta } from "@meshbot/types-agent";
import { MeshbotConfigService } from "../config/meshbot-config.service";

/**
 * 人格主文件名：UI 置顶、不可删、不可改名。list() 恒把它排在首位（物理不存在
 * 时也返回占位）；Task 2（system:prompts 注入）/ Task 3（前端提示词 tab）消费。
 */
export const PROMPT_FILE_MAIN = "AGENT.md";

/** 提示词文件名合法字符集：字母数字下划线点横杠 + 必须 .md 结尾（禁 `/` 等路径分隔符）。 */
const PROMPT_FILE_NAME_RE = /^[\w.-]+\.md$/;

/**
 * 校验提示词文件名——纯函数，供本文件内部复用，也供 controller 前置校验
 * （避免非法名字进 Agent ALS 才报错）。只做字符集/后缀检查；不依赖文件系统。
 */
export function isValidPromptFileName(name: string): boolean {
  return PROMPT_FILE_NAME_RE.test(name);
}

/**
 * PromptFileService —— `<agentDir>/prompts/` 目录 CRUD（Agent 编辑器 v2 第一段地基）。
 *
 * 注意与账号级 `libs/agent/src/prompt/`（单数，PromptService，另一套兜底人格机制）
 * 区分：本服务是 Agent 级、复数目录名 `prompts/`，只做文件 I/O，不碰注入链路、
 * 不碰 `agent.system_prompt` DB 列（那是 Task 2 的范围）。
 *
 * 全部方法要求 Agent ALS（经 MeshbotConfigService.getPromptsDir() → agentDir()
 * → AgentContextService.getOrThrow() 强制），离开 Agent 上下文调用会抛错。
 */
@Injectable()
export class PromptFileService {
  constructor(private readonly config: MeshbotConfigService) {}

  /** 列出全部提示词文件元信息：AGENT.md 恒首位（不存在也占位），其余按文件名字典序。 */
  list(): PromptFileMeta[] {
    const dir = this.config.getPromptsDir();
    // 用小写文件名去重，兼容「同一逻辑文件的不同大小写」在极端情况下并存
    // （例如人机互通场景手工放的文件）；后写入 Map 的条目会覆盖先写入的。
    const byLowerName = new Map<string, PromptFileMeta>();
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        if (!isValidPromptFileName(entry)) continue; // 目录里混入的非法命名杂散文件，宽松跳过不报错
        const abs = path.join(dir, entry);
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        byLowerName.set(entry.toLowerCase(), {
          file: entry,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
    }

    const mainKey = PROMPT_FILE_MAIN.toLowerCase();
    const main = byLowerName.get(mainKey) ?? {
      file: PROMPT_FILE_MAIN,
      size: 0,
      mtime: null,
    };
    byLowerName.delete(mainKey);
    const rest = [...byLowerName.values()].sort((a, b) =>
      a.file.localeCompare(b.file),
    );
    return [main, ...rest];
  }

  /** 读取单个提示词文件全文；文件不存在返回空字符串（非法文件名抛错）。 */
  read(file: string): string {
    const target = this.resolveExisting(file);
    if (!target) return "";
    return readFileSync(target, "utf8");
  }

  /** 写入单个提示词文件（新建同一入口）；惰性 mkdir prompts 目录。 */
  write(file: string, content: string): void {
    const { dir, abs } = this.resolveTarget(file);
    mkdirSync(dir, { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  /** 删除单个提示词文件；AGENT.md（含大小写变体）拒绝删除并抛错。 */
  remove(file: string): void {
    if (!isValidPromptFileName(file)) {
      throw new Error(`非法提示词文件名：${file}`);
    }
    if (file.toLowerCase() === PROMPT_FILE_MAIN.toLowerCase()) {
      throw new Error(`${PROMPT_FILE_MAIN} 是人格主文件，不可删除`);
    }
    const target = this.resolveExisting(file);
    if (!target) return; // 不存在视为已删除，幂等 no-op
    rmSync(target);
  }

  /**
   * 校验 + 解析写入目标的绝对路径。大小写不敏感去重：若目录内已存在同名
   * （不分大小写）文件，复用其真实磁盘文件名，避免 `AGENT.md` / `Agent.md`
   * 同时并存成两个文件。resolve 后仍要求落在 prompts 目录内——防路径穿越的
   * 第二道防线（正则已禁 `/`，这里兜底防符号链接等边缘绕过手法）。
   */
  private resolveTarget(file: string): { dir: string; abs: string } {
    if (!isValidPromptFileName(file)) {
      throw new Error(`非法提示词文件名：${file}`);
    }
    const dir = this.config.getPromptsDir();
    const existing = this.findExisting(dir, file);
    const name = existing ?? file;
    const abs = path.resolve(dir, name);
    const dirWithSep = `${path.resolve(dir)}${path.sep}`;
    if (!abs.startsWith(dirWithSep)) {
      throw new Error(`非法提示词文件名（路径穿越）：${file}`);
    }
    return { dir, abs };
  }

  /** 解析一个「必须已存在」的目标（read/remove 共用）；未命中返回 null。 */
  private resolveExisting(file: string): string | null {
    if (!isValidPromptFileName(file)) {
      throw new Error(`非法提示词文件名：${file}`);
    }
    const dir = this.config.getPromptsDir();
    const existing = this.findExisting(dir, file);
    if (!existing) return null;
    const abs = path.resolve(dir, existing);
    const dirWithSep = `${path.resolve(dir)}${path.sep}`;
    if (!abs.startsWith(dirWithSep)) {
      throw new Error(`非法提示词文件名（路径穿越）：${file}`);
    }
    return abs;
  }

  /** 目录内大小写不敏感匹配 name 的真实文件名；目录不存在或未命中返回 null。 */
  private findExisting(dir: string, name: string): string | null {
    if (!existsSync(dir)) return null;
    const lower = name.toLowerCase();
    for (const entry of readdirSync(dir)) {
      if (entry.toLowerCase() === lower) return entry;
    }
    return null;
  }
}
