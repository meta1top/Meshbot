import { z } from "zod";

export const MarketSkillSummarySchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  author: z.string(),
  latestVersion: z.string(),
  downloads: z.number(),
});
export type MarketSkillSummary = z.infer<typeof MarketSkillSummarySchema>;

export const SkillVersionInfoSchema = z.object({
  version: z.string(),
  changelog: z.string().nullable(),
  createdAt: z.string(),
});

export const MarketSkillDetailSchema = MarketSkillSummarySchema.extend({
  readme: z.string(), // 最新版本的 SKILL.md 文本
  versions: z.array(SkillVersionInfoSchema),
});
export type MarketSkillDetail = z.infer<typeof MarketSkillDetailSchema>;

export const PublishSkillSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().min(1).max(128),
  description: z.string().min(1),
  version: z.string().min(1).max(32),
  changelog: z.string().optional(),
  readme: z.string().min(1), // SKILL.md 文本(详情展示用，免每次下载解包)
  archiveBase64: z.string().min(1), // 技能目录 zip 的 base64
});
export type PublishSkillInput = z.infer<typeof PublishSkillSchema>;
