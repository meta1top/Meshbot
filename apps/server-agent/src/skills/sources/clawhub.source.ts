import type { MarketSkillSummary } from "@meshbot/types-agent";
import { AppError } from "@meshbot/common";
import { AgentErrorCode } from "../../errors/agent.error-codes";
import type { SkillPackage, SkillSourceAdapter } from "./skill-source";

/** clawhub.ai API 返回的技能条目形状（按公开 API 推断）。 */
interface ClawhubSkillItem {
  slug?: string;
  name?: string;
  display_name?: string;
  description?: string;
  author?: string;
  version?: string;
  downloads?: number;
}

/**
 * Clawhub 来源适配器（本期仅浏览）。
 * - list：从 clawhub.ai 拉取技能列表并映射为 MarketSkillSummary。
 * - fetchPackage：下载端点待 docs.openclaw.ai 确认，本期不支持，抛 SKILL_SOURCE_UNSUPPORTED。
 */
export class ClawhubSource implements SkillSourceAdapter {
  /**
   * 从 clawhub.ai 获取技能列表并映射为 MarketSkillSummary。
   * 若 API 返回非 200 或解析失败，返回空数组（浏览功能降级）。
   */
  async list(q?: string): Promise<MarketSkillSummary[]> {
    const url = q
      ? `https://clawhub.ai/api/v1/skills?q=${encodeURIComponent(q)}`
      : "https://clawhub.ai/api/v1/skills";

    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return [];
    }

    if (!res.ok) return [];

    let items: unknown;
    try {
      items = await res.json();
    } catch {
      return [];
    }

    const raw = Array.isArray(items)
      ? items
      : ((items as { data?: unknown[] }).data ?? []);

    return (raw as ClawhubSkillItem[]).map((item) => ({
      source: "clawhub" as const,
      ref: item.slug ?? "",
      slug: item.slug ?? "",
      displayName: item.display_name ?? item.name ?? item.slug ?? "",
      description: item.description ?? "",
      author: item.author ?? "",
      latestVersion: item.version ?? "0.0.0",
      downloads: item.downloads,
    }));
  }

  /**
   * Clawhub 本期不支持安装（下载端点待 docs.openclaw.ai 确认）。
   * 始终抛出 SKILL_SOURCE_UNSUPPORTED。
   */
  async fetchPackage(_ref: string, _version?: string): Promise<SkillPackage> {
    throw new AppError(AgentErrorCode.SKILL_SOURCE_UNSUPPORTED);
  }
}
