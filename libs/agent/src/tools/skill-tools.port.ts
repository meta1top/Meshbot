/** libs/agent → apps/server-agent 解耦的注入边界（技能管理）。
 *
 * apps/server-agent 在 skill.module 用 useFactory adapter 提供实现
 * （委托 SkillInstallService）。同 SCHEDULE_TOOLS_PORT 范式。
 */
export const SKILL_TOOLS_PORT = Symbol("SKILL_TOOLS_PORT");

/** 已安装技能的最小投影（tool 序列化给 LLM 用）。 */
export interface InstalledSkillView {
  name: string;
  description: string;
  source: string | null;
  ref: string | null;
  version: string | null;
}

/** 市场技能的最小投影（tool 序列化给 LLM 用）。 */
export interface MarketSkillView {
  source: string;
  slug: string;
  displayName: string;
  description: string;
  author: string;
  latestVersion: string;
}

/** 技能安装来源。 */
export type SkillToolSource = "system" | "github" | "clawhub";

/** 技能管理端口：tool 依赖此接口，server-agent 提供实现。 */
export interface SkillToolsPort {
  /** 安装技能（来源 + ref + 可选版本）。 */
  install(input: {
    source: SkillToolSource;
    ref: string;
    version?: string;
  }): Promise<InstalledSkillView>;
  /** 卸载技能（按目录名）。 */
  uninstall(name: string): Promise<void>;
  /** 搜索/浏览市场技能（github 无检索返回空）。 */
  searchMarket(
    source: SkillToolSource,
    query?: string,
  ): Promise<MarketSkillView[]>;
  /** 把本地技能发布到云端市场。 */
  publish(input: {
    name: string;
    slug: string;
    displayName: string;
    version: string;
    changelog?: string;
  }): Promise<void>;
}
