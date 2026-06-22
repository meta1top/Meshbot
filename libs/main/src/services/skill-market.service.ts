import { AppError } from "@meshbot/common";
import {
  type MarketSkillDetail,
  type MarketSkillSummary,
  type PublishSkillInput,
} from "@meshbot/types-main";
import { AssetService } from "@meshbot/assets";
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { MainErrorCode } from "../errors/main.error-codes";
import { SkillPackageService } from "./skill-package.service";

/**
 * 技能市场业务编排 Service。
 * 注入 SkillPackageService（DB CRUD）+ AssetService（对象存储），
 * 不直接持有 @InjectRepository（check:repo）。
 */
@Injectable()
export class SkillMarketService {
  constructor(
    private readonly packageService: SkillPackageService,
    private readonly assets: AssetService,
  ) {}

  /** 列出公开技能市场摘要列表（支持关键字搜索）。 */
  async list(q?: string): Promise<MarketSkillSummary[]> {
    const pkgs = await this.packageService.list(q);
    return pkgs.map((pkg) => ({
      slug: pkg.slug,
      displayName: pkg.displayName,
      description: pkg.description,
      author: pkg.authorUserId,
      latestVersion: pkg.latestVersion,
      downloads: pkg.downloads,
    }));
  }

  /** 取技能详情（包含所有版本列表 + 最新版本 readme）。不存在返回 null。 */
  async detail(slug: string): Promise<MarketSkillDetail | null> {
    const pkg = await this.packageService.getBySlug(slug);
    if (!pkg) return null;

    const versions = await this.packageService.listVersions(pkg.id);
    const latestVer = versions[0];

    return {
      slug: pkg.slug,
      displayName: pkg.displayName,
      description: pkg.description,
      author: pkg.authorUserId,
      latestVersion: pkg.latestVersion,
      downloads: pkg.downloads,
      readme: latestVer?.readme ?? "",
      versions: versions.map((v) => ({
        version: v.version,
        changelog: v.changelog,
        createdAt: v.createdAt.toISOString(),
      })),
    };
  }

  /**
   * 下载技能 tarball 流。
   * 缺省 version 时取最新版本；同时 downloads +1。
   * 不存在返回 null。
   */
  async download(
    slug: string,
    version?: string,
  ): Promise<{ stream: NodeJS.ReadableStream; filename: string } | null> {
    const pkg = await this.packageService.getBySlug(slug);
    if (!pkg) return null;

    const targetVersion = version ?? pkg.latestVersion;
    const ver = await this.packageService.getVersion(pkg.id, targetVersion);
    if (!ver) return null;

    const stream = await this.assets.getStream(ver.assetKey);
    await this.packageService.incrementDownloads(pkg.id);

    return {
      stream,
      filename: `${slug}-${targetVersion}.tar.gz`,
    };
  }

  /**
   * 发布技能。
   * 流程：base64 解码 tarball → 计算 sha256 → 上传 minio → 持久化元数据。
   * 同 slug 非作者抛 SKILL_FORBIDDEN。
   */
  async publish(authorUserId: string, input: PublishSkillInput): Promise<void> {
    // 同 slug 已存在时校验作者归属
    const existing = await this.packageService.getBySlug(input.slug);
    if (existing && existing.authorUserId !== authorUserId) {
      throw new AppError(MainErrorCode.SKILL_FORBIDDEN);
    }

    const tarball = Buffer.from(input.tarballBase64, "base64");
    const checksum = createHash("sha256").update(tarball).digest("hex");
    const assetKey = `skills/${input.slug}/${input.version}.tar.gz`;

    await this.assets.put(assetKey, tarball, "application/gzip");
    await this.packageService.persistPublish(
      authorUserId,
      input,
      assetKey,
      checksum,
      tarball.length,
    );
  }
}
