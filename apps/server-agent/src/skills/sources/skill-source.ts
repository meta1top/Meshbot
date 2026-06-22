import type { MarketSkillSummary } from "@meshbot/types-agent";

/** fetchPackage 的返回值：tar.gz 二进制 + 建议的技能目录名。 */
export interface SkillPackage {
  /** tar.gz 原始内容。 */
  tarGz: Buffer;
  /** 建议的本地技能目录名（由源适配器决定，可来自 ref 解析或 slug）。 */
  suggestedName: string;
}

/**
 * 技能来源适配器接口。
 * - list：从该源检索/浏览技能（不支持检索的源返回空数组）。
 * - fetchPackage：下载并返回技能 tar.gz（不支持下载的源抛 SKILL_SOURCE_UNSUPPORTED）。
 */
export interface SkillSourceAdapter {
  /** 检索/浏览市场技能；不支持的源返回 []。 */
  list(q?: string): Promise<MarketSkillSummary[]>;
  /** 下载技能包；不支持安装的源抛 AppError(SKILL_SOURCE_UNSUPPORTED)。 */
  fetchPackage(ref: string, version?: string): Promise<SkillPackage>;
}
