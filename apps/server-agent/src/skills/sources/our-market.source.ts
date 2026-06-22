import { AccountContextService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { MarketSkillSummary } from "@meshbot/types-agent";
import { AgentErrorCode } from "../../errors/agent.error-codes";
import { CloudClientService } from "../../cloud/cloud-client.service";
import { CloudIdentityService } from "../../services/cloud-identity.service";
import type { SkillPackage, SkillSourceAdapter } from "./skill-source";

/** server-main /api/skills 列表返回项形状。 */
interface MarketSkillApiItem {
  slug: string;
  displayName: string;
  description: string;
  author: string;
  latestVersion: string;
  downloads?: number;
}

/**
 * 我们的市场来源适配器，经 CloudClientService 代理 server-main。
 *
 * 注意：二进制 tarball 下载**绕过 CloudClientService**（它只解 JSON 信封），
 * 直接用 Node 原生 fetch 携带 Authorization Bearer token 获取 arraybuffer。
 */
@Injectable()
export class OurMarketSource implements SkillSourceAdapter {
  private readonly baseUrl: string;

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
    config: ConfigService,
  ) {
    this.baseUrl = config.getOrThrow<string>("MESHBOT_CLOUD_URL");
  }

  /**
   * 搜索/浏览我们市场的技能列表。
   */
  async list(q?: string): Promise<MarketSkillSummary[]> {
    const path = q ? `/api/skills?q=${encodeURIComponent(q)}` : "/api/skills";
    const token = await this.token();
    const items = await this.cloud.get<MarketSkillApiItem[]>(path, token);
    return items.map((item) => ({
      source: "ourMarket" as const,
      ref: item.slug,
      slug: item.slug,
      displayName: item.displayName,
      description: item.description,
      author: item.author,
      latestVersion: item.latestVersion,
      downloads: item.downloads,
    }));
  }

  /**
   * 下载技能 tarball。
   *
   * CloudClientService 仅处理 JSON 信封，二进制下载需直接 fetch 并携带 token。
   * 下载路径：GET /api/skills/<slug>/<version>/download
   */
  async fetchPackage(slug: string, version?: string): Promise<SkillPackage> {
    const token = await this.token();

    // 若未指定 version，先拉详情取 latestVersion
    let ver = version;
    if (!ver) {
      const detail = await this.cloud.get<{ latestVersion: string }>(
        `/api/skills/${slug}`,
        token,
      );
      ver = detail.latestVersion;
    }

    // 直接 fetch 二进制（绕过 CloudClientService JSON 信封解析）
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/skills/${slug}/${ver}/download`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new AppError(AgentErrorCode.CLOUD_UNREACHABLE);
    }

    if (!res.ok) {
      if (res.status === 404) {
        throw new AppError(AgentErrorCode.SKILL_NOT_FOUND);
      }
      if (res.status === 401) {
        throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
      }
      throw new AppError(AgentErrorCode.SKILL_INSTALL_FAILED);
    }

    const arrayBuf = await res.arrayBuffer();
    return {
      tarGz: Buffer.from(arrayBuf),
      suggestedName: slug,
    };
  }

  /** 获取当前账号的 cloud token。 */
  private async token(): Promise<string> {
    const id = await this.identity.get(this.account.getOrThrow());
    if (!id?.cloudToken) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    return id.cloudToken;
  }
}
