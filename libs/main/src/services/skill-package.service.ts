import { Transactional } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { SkillPackage } from "../entities/skill-package.entity";
import { SkillVersion } from "../entities/skill-version.entity";
import type { PublishSkillInput } from "@meshbot/types-main";

/**
 * SkillPackage + SkillVersion 的唯一归属 Service（check:repo）。
 * 纯 DB CRUD，不含业务编排逻辑（业务由 SkillMarketService 编排）。
 */
@Injectable()
export class SkillPackageService {
  constructor(
    @InjectRepository(SkillPackage)
    private readonly packageRepo: Repository<SkillPackage>,
    @InjectRepository(SkillVersion)
    private readonly versionRepo: Repository<SkillVersion>,
  ) {}

  /**
   * 列出所有公开技能包，按下载量降序排列。
   * 支持按 slug/displayName 关键字模糊搜索。
   */
  async list(q?: string): Promise<SkillPackage[]> {
    const qb = this.packageRepo
      .createQueryBuilder("p")
      .where("p.public = :pub", { pub: true })
      .orderBy("p.downloads", "DESC");
    if (q) {
      qb.andWhere("(p.slug ILIKE :q OR p.display_name ILIKE :q)", {
        q: `%${q}%`,
      });
    }
    return qb.getMany();
  }

  /** 按 slug 查询技能包，不存在返回 null。 */
  async getBySlug(slug: string): Promise<SkillPackage | null> {
    return this.packageRepo.findOneBy({ slug });
  }

  /** 列出某包的所有版本，按创建时间降序。 */
  async listVersions(packageId: string): Promise<SkillVersion[]> {
    return this.versionRepo.find({
      where: { packageId },
      order: { createdAt: "DESC" },
    });
  }

  /** 查询某包的特定版本，不存在返回 null。 */
  async getVersion(
    packageId: string,
    version: string,
  ): Promise<SkillVersion | null> {
    return this.versionRepo.findOneBy({ packageId, version });
  }

  /** 下载次数 +1。 */
  async incrementDownloads(packageId: string): Promise<void> {
    await this.packageRepo.increment({ id: packageId }, "downloads", 1);
  }

  /**
   * 发布技能：跨两表写入（upsert skill_package + insert skill_version + 更新 latestVersion）。
   * 走 @Transactional()（check:naming 要求 persist* 命名）。
   */
  @Transactional()
  async persistPublish(
    authorUserId: string,
    input: PublishSkillInput,
    assetKey: string,
    checksum: string,
    sizeBytes: number,
  ): Promise<void> {
    let pkg = await this.packageRepo.findOneBy({ slug: input.slug });
    if (!pkg) {
      pkg = await this.packageRepo.save(
        this.packageRepo.create({
          slug: input.slug,
          displayName: input.displayName,
          description: input.description,
          authorUserId,
          latestVersion: input.version,
          public: true,
          downloads: 0,
        }),
      );
    } else {
      pkg.displayName = input.displayName;
      pkg.description = input.description;
      pkg.latestVersion = input.version;
      await this.packageRepo.save(pkg);
    }

    await this.versionRepo.save(
      this.versionRepo.create({
        packageId: pkg.id,
        version: input.version,
        assetKey,
        checksum,
        sizeBytes,
        readme: input.readme,
        changelog: input.changelog ?? null,
      }),
    );
  }
}
