import { AgentModule } from "@meshbot/agent";
import { Module } from "@nestjs/common";
import { AuthModule } from "./auth.module";
import { SkillController } from "./controllers/skill.controller";
import { ClawhubSource } from "./skills/sources/clawhub.source";
import { GithubSource } from "./skills/sources/github.source";
import { OurMarketSource } from "./skills/sources/our-market.source";
import { SkillInstallService } from "./skills/skill-install.service";

/**
 * 技能市场模块：三源适配器 + SkillInstallService + SkillController。
 *
 * 依赖：
 * - AgentModule：提供 SkillService（天然热 skills 列表扫描）+ MeshbotConfigService（re-export）
 * - AuthModule：提供 CloudClientService + CloudIdentityService
 * - AccountContextService：来自 @Global AccountContextModule（AgentModule 已 import）
 */
@Module({
  imports: [AgentModule, AuthModule],
  controllers: [SkillController],
  providers: [
    GithubSource,
    ClawhubSource,
    OurMarketSource,
    SkillInstallService,
  ],
})
export class SkillModule {}
