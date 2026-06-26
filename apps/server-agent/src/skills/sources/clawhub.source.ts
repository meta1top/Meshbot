import type { MarketSkillSummary } from "@meshbot/types-agent";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { AgentErrorCode } from "../../errors/agent.error-codes";
import type { SkillPackage, SkillSourceAdapter } from "./skill-source";

/**
 * clawhub.ai API 返回的技能条目形状（按 2026-06 真实响应校准）。
 * 搜索（/search）与浏览（/skills）字段不完全一致，做并集：
 * - 搜索条目：`downloads` 扁平、作者在 `ownerHandle`/`owner.handle`、`version` 多为 null
 * - 浏览条目：下载在 `stats.downloads`、版本在 `latestVersion.version`、`description` 多为 null
 * 两端展示名都在 `displayName`、简介都在 `summary`。
 */
interface ClawhubSkillItem {
  slug?: string;
  displayName?: string;
  summary?: string;
  description?: string;
  ownerHandle?: string;
  owner?: { handle?: string };
  version?: string | null;
  latestVersion?: { version?: string };
  tags?: { latest?: string };
  downloads?: number;
  stats?: { downloads?: number };
}

/**
 * Clawhub 来源适配器。
 * - list：无关键字走 `GET /api/v1/skills`（信封 `{items}`），有关键字走
 *   `GET /api/v1/search?q=`（信封 `{results}`，词法/关键词检索、非自然语言），映射为 MarketSkillSummary。
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

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return [];
    }

    // 信封：search→{results}、browse→{items}；data 为防御性兜底，亦容忍裸数组。
    const env = payload as {
      results?: unknown[];
      items?: unknown[];
      data?: unknown[];
    };
    const raw = Array.isArray(payload)
      ? payload
      : (env.results ?? env.items ?? env.data ?? []);

    return (raw as ClawhubSkillItem[]).map((item) => ({
      source: "clawhub" as const,
      ref: item.slug ?? "",
      slug: item.slug ?? "",
      displayName: item.displayName ?? item.slug ?? "",
      // summary 是两端共有的简介；浏览的 description 多为 null，仅作兜底。
      description: item.summary ?? item.description ?? "",
      author: item.ownerHandle ?? item.owner?.handle ?? "",
      // 版本取处：浏览在 latestVersion.version / tags.latest；搜索的 version 多为
      // null（且无 latestVersion/tags）→ 落空串表「未知」，由前端隐藏徽章、安装回退最新。
      latestVersion:
        item.latestVersion?.version ?? item.version ?? item.tags?.latest ?? "",
      downloads: item.downloads ?? item.stats?.downloads,
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
