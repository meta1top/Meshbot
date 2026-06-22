import type {
  InstalledSkill,
  MarketSkillSummary,
  SkillInstallSource,
} from "@meshbot/types-agent";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { InstallSkillDto, PublishLocalSkillDto } from "../dto/skill.dto";
import { SkillInstallService } from "../skills/skill-install.service";

/** 技能市场 REST 端点。瘦 Controller —— 业务在 SkillInstallService。 */
@Controller("api/skills")
export class SkillController {
  constructor(private readonly installService: SkillInstallService) {}

  /**
   * 检索/浏览市场技能列表。
   *
   * @param source 技能来源（ourMarket / github / clawhub）
   * @param q 搜索关键词（可选）
   */
  @Get("market")
  async market(
    @Query("source") source: SkillInstallSource,
    @Query("q") q?: string,
  ): Promise<MarketSkillSummary[]> {
    return this.installService.market(source, q);
  }

  /** 列出已安装技能。 */
  @Get("installed")
  async listInstalled(): Promise<InstalledSkill[]> {
    return this.installService.listInstalled();
  }

  /**
   * 安装技能：下载 tarball → 解包 → 写清单 → 返 InstalledSkill。
   */
  @Post("install")
  async install(@Body() body: InstallSkillDto): Promise<InstalledSkill> {
    return this.installService.install(body);
  }

  /**
   * 卸载技能（按目录名）。
   *
   * @param name 技能目录名
   */
  @Delete(":name")
  async uninstall(@Param("name") name: string): Promise<{ deleted: true }> {
    await this.installService.uninstall(name);
    return { deleted: true };
  }

  /**
   * 发布本地技能到 server-main 市场。
   */
  @Post("publish")
  async publish(@Body() body: PublishLocalSkillDto): Promise<{ ok: true }> {
    await this.installService.publish(body);
    return { ok: true };
  }
}
