import { AgentContextService } from "@meshbot/lib-agent";
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
import { AgentService } from "../services/agent.service";
import { SkillInstallService } from "../skills/skill-install.service";

/** 技能市场 REST 端点。瘦 Controller —— 业务在 SkillInstallService。 */
@Controller("api/skills")
export class SkillController {
  constructor(
    private readonly installService: SkillInstallService,
    private readonly agentCtx: AgentContextService,
    private readonly agents: AgentService,
  ) {}

  /**
   * 解析 agentId：未传/空串兜底取当前账号默认 Agent；显式传入必须校验存在且
   * 归属当前账号（`findOrThrow` 经 `ScopedRepository` 自动按账号过滤，越权 id
   * 天然 404）—— 与 `SessionController.create` 同一模式。
   */
  private async resolveAgentId(agentId?: string): Promise<string> {
    if (agentId) {
      return (await this.agents.findOrThrow(agentId)).id;
    }
    return (await this.agents.ensureDefault()).id;
  }

  /**
   * 检索/浏览市场技能列表。不落磁盘，无需 Agent 上下文。
   *
   * @param source 技能来源（system / github / clawhub）
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
  async listInstalled(
    @Query("agentId") agentId?: string,
  ): Promise<InstalledSkill[]> {
    const id = await this.resolveAgentId(agentId);
    return this.agentCtx.run(id, () => this.installService.listInstalled());
  }

  /**
   * 安装技能：下载 tarball → 解包 → 写清单 → 返 InstalledSkill。
   */
  @Post("install")
  async install(@Body() body: InstallSkillDto): Promise<InstalledSkill> {
    const id = await this.resolveAgentId(body.agentId);
    return this.agentCtx.run(id, () => this.installService.install(body));
  }

  /**
   * 卸载技能（按目录名）。
   *
   * @param name 技能目录名
   */
  @Delete(":name")
  async uninstall(
    @Param("name") name: string,
    @Query("agentId") agentId?: string,
  ): Promise<{ deleted: true }> {
    const id = await this.resolveAgentId(agentId);
    await this.agentCtx.run(id, () => this.installService.uninstall(name));
    return { deleted: true };
  }

  /**
   * 发布本地技能到 server-main 市场。
   */
  @Post("publish")
  async publish(@Body() body: PublishLocalSkillDto): Promise<{ ok: true }> {
    const id = await this.resolveAgentId(body.agentId);
    await this.agentCtx.run(id, () => this.installService.publish(body));
    return { ok: true };
  }
}
