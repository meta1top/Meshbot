import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { PROTECTED_TOOLS, ToolPrefsSchema } from "@meshbot/types-agent";
import { MeshbotConfigService } from "../config/meshbot-config.service";

/** 豁免工具集合（Set 形态，便于 O(1) 判定；从 types-agent 的 as const 元组派生）。 */
const PROTECTED_SET = new Set<string>(PROTECTED_TOOLS);

/**
 * ToolPrefsService —— `<agentDir>/tools.json` 读写（Agent 编辑器 v2 第二段地基）。
 *
 * 对照 PromptFileService 形态：MeshbotConfigService 注入 + Agent ALS，全部方法
 * 要求 Agent 上下文（经 MeshbotConfigService.getToolsConfigPath() → agentDir()
 * → AgentContextService.getOrThrow() 强制），离开 Agent 上下文调用会抛错。
 *
 * 豁免（PROTECTED_TOOLS：todo_write / ask_question）读取、写入两处都剔除——
 * 双保险：即便文件被人手改坏也不会在读取侧生效；写入侧提前剔除避免脏数据落盘。
 * 文件缺失或内容损坏（非法 JSON / 不符合 schema）时，读取返回空集（视为「全部
 * 启用」）并 warn，不抛错——不能因为一份坏配置文件让 Agent 整体不可用。
 */
@Injectable()
export class ToolPrefsService {
  private readonly logger = new Logger(ToolPrefsService.name);

  constructor(private readonly config: MeshbotConfigService) {}

  /** 读取当前 Agent 的禁用工具集合；剔除豁免；缺失/损坏返回空集（不抛错）。 */
  getDisabledTools(): ReadonlySet<string> {
    const filePath = this.config.getToolsConfigPath();
    if (!existsSync(filePath)) {
      return new Set();
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      this.logger.warn(`读取 tools.json 失败（${filePath}）：${String(err)}`);
      return new Set();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(
        `tools.json 内容损坏（非法 JSON，${filePath}）：${String(err)}`,
      );
      return new Set();
    }

    const result = ToolPrefsSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        `tools.json 内容不符合 schema（${filePath}）：${result.error.message}`,
      );
      return new Set();
    }

    return new Set(
      result.data.disabledTools.filter((name) => !PROTECTED_SET.has(name)),
    );
  }

  /**
   * 写入禁用工具列表：剔除豁免 + 去重 + Zod 校验后落盘（惰性 mkdir agent 目录）。
   * @param names 待禁用的工具名列表（可含重复 / 豁免项，均会被清理）
   */
  setDisabledTools(names: string[]): void {
    const deduped = [...new Set(names)].filter(
      (name) => !PROTECTED_SET.has(name),
    );
    const prefs = ToolPrefsSchema.parse({ disabledTools: deduped });

    const filePath = this.config.getToolsConfigPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(prefs, null, 2), "utf8");
  }
}
