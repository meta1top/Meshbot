import {
  AgentModule,
  SKILL_TOOLS_PORT,
  type SkillToolsPort,
} from "@meshbot/agent";
import { Global, Module } from "@nestjs/common";
import { AuthModule } from "./auth.module";
import { SkillController } from "./controllers/skill.controller";
import { ClawhubSource } from "./skills/sources/clawhub.source";
import { GithubSource } from "./skills/sources/github.source";
import { OurMarketSource } from "./skills/sources/our-market.source";
import { SkillInstallService } from "./skills/skill-install.service";

/**
 * 技能市场模块：三源适配器 + SkillInstallService + SkillController + 技能工具端口。
 *
 * @Global 让 SKILL_TOOLS_PORT 被任何 module 解析（含 AgentModule 内的
 * skill_install / skill_uninstall / skill_search_market / skill_publish 四个 tool），
 * 同 CronJobModule 范式。
 *
 * 依赖：
 * - AgentModule：提供 SkillService（天然热 skills 列表扫描）+ MeshbotConfigService（re-export）
 * - AuthModule：提供 CloudClientService + CloudIdentityService
 * - AccountContextService：来自 @Global AccountContextModule（AgentModule 已 import）
 */
@Global()
@Module({
  imports: [AgentModule, AuthModule],
  controllers: [SkillController],
  providers: [
    GithubSource,
    ClawhubSource,
    OurMarketSource,
    SkillInstallService,
    {
      provide: SKILL_TOOLS_PORT,
      useFactory: (svc: SkillInstallService): SkillToolsPort => ({
        install: (input) => svc.install(input),
        uninstall: (name: string) => svc.uninstall(name),
        searchMarket: (source, query) => svc.market(source, query),
        publish: (input) => svc.publish(input),
      }),
      inject: [SkillInstallService],
    },
  ],
  exports: [SKILL_TOOLS_PORT],
})
export class SkillModule {}
