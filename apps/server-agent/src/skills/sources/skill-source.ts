import type { MarketSkillSummary } from "@meshbot/types-agent";

/** fetchPackage 的返回值：zip 二进制 + 建议的技能目录名。 */
export interface SkillPackage {
  /** zip 原始内容。 */
  archive: Buffer;
  /** 建议的本地技能目录名（由源适配器决定，可来自 ref 解析或 slug）。 */
  suggestedName: string;
}

/**
 * 技能来源适配器接口。
 * - list：从该源检索/浏览技能（不支持检索的源返回空数组）。
 * - fetchPackage：下载并返回技能 zip 包。
 */
export interface SkillSourceAdapter {
  /** 检索/浏览市场技能；不支持的源返回 []。 */
  list(q?: string): Promise<MarketSkillSummary[]>;
  /** 下载技能 zip 包。 */
  fetchPackage(ref: string, version?: string): Promise<SkillPackage>;
}
