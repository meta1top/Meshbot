import type { MarketSkillSummary } from "@meshbot/types-agent";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
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
 * Clawhub 来源适配器。
 * - list：无关键字走 `GET /api/v1/skills`，有关键字走 `GET /api/v1/search?q=`，映射为 MarketSkillSummary。
 * - fetchPackage：`GET /api/v1/download?slug=&version=` 取 zip 包安装。
 */
@Injectable()
export class ClawhubSource implements SkillSourceAdapter {
  /**
   * 从 clawhub.ai 获取/搜索技能列表并映射为 MarketSkillSummary。
   * 若 API 返回非 200 或解析失败，返回空数组（浏览功能降级）。
   */
  async list(q?: string): Promise<MarketSkillSummary[]> {
    const url = q
      ? `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(q)}`
      : "https://clawhub.ai/api/v1/skills";

    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return [];
    }

    if (!res.ok) {
      return [];
    }

    let items: unknown;
    try {
      items = await res.json();
    } catch {
      return [];
    }

    const raw = Array.isArray(items)
      ? items
      : ((items as { data?: unknown[]; items?: unknown[] }).data ??
        (items as { items?: unknown[] }).items ??
        []);

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
   * 从 clawhub.ai 下载技能 zip 包。
   * `GET /api/v1/download?slug=<slug>[&version=<version>]` 返回 zip 归档。
   */
  async fetchPackage(ref: string, version?: string): Promise<SkillPackage> {
    const url = new URL("https://clawhub.ai/api/v1/download");
    url.searchParams.set("slug", ref);
    if (version) {
      url.searchParams.set("version", version);
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new AppError(AgentErrorCode.SKILL_INSTALL_FAILED);
    }

    const archive = Buffer.from(await res.arrayBuffer());
    return { archive, suggestedName: ref };
  }
}
