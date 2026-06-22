import { z } from "zod";

/** 技能来源枚举。 */
export type SkillInstallSource = "system" | "github" | "clawhub";

/** 市场技能摘要（三源通用）。 */
export const MarketSkillSummarySchema = z.object({
  source: z.enum(["system", "github", "clawhub"]),
  ref: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  author: z.string(),
  latestVersion: z.string(),
  downloads: z.number().optional(),
});
export type MarketSkillSummary = z.infer<typeof MarketSkillSummarySchema>;

/** 已安装技能（扫目录 + .meshbot-install.json 合并）。 */
export const InstalledSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["system", "github", "clawhub"]).nullable(),
  ref: z.string().nullable(),
  version: z.string().nullable(),
  installedAt: z.string().nullable(),
});
export type InstalledSkill = z.infer<typeof InstalledSkillSchema>;

/** POST /api/skills/install 入参。 */
export const InstallSkillSchema = z.object({
  /** system=slug；github=owner/repo[@ref]；clawhub=slug */
  source: z.enum(["system", "github", "clawhub"]),
  ref: z.string().min(1),
  version: z.string().optional(),
});
export type InstallSkillInput = z.infer<typeof InstallSkillSchema>;

/** POST /api/skills/publish 入参（把本地技能打包上传到 server-main）。 */
export const PublishLocalSkillSchema = z.object({
  /** 本地 skills/<name> 目录名 */
  name: z.string().min(1),
  slug: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().min(1),
  changelog: z.string().optional(),
});
export type PublishLocalSkillInput = z.infer<typeof PublishLocalSkillSchema>;
