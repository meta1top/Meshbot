import { z } from "zod";

/** 默认 Agent 的名字（账号下零 agent 时自动创建）。 */
export const DEFAULT_AGENT_NAME = "M";

/** 默认 Agent 的头像：`emoji|背景色` 两段式，前端拆开渲染。 */
export const DEFAULT_AGENT_AVATAR = "🤖|#f97316";

/** 远程可见性。本期恒 private，org 为云端注册（计划二）预留。 */
export const AgentVisibilitySchema = z.enum(["private", "org"]);

/** 创建 Agent 的入参。 */
export const AgentCreateSchema = z.object({
  name: z.string().min(1).max(32),
  avatar: z.string().min(1).max(64),
  description: z.string().max(200).default(""),
  systemPrompt: z.string().max(20_000).default(""),
  defaultModelConfigId: z.string().nullable().default(null),
});

/** 更新 Agent 的入参（全字段可选）。 */
export const AgentUpdateSchema = AgentCreateSchema.partial().extend({
  remoteEnabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/** Agent 对外视图。 */
export const AgentViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  defaultModelConfigId: z.string().nullable(),
  remoteEnabled: z.boolean(),
  visibility: AgentVisibilitySchema,
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AgentVisibility = z.infer<typeof AgentVisibilitySchema>;
export type AgentCreateInput = z.infer<typeof AgentCreateSchema>;
export type AgentUpdateInput = z.infer<typeof AgentUpdateSchema>;
export type AgentView = z.infer<typeof AgentViewSchema>;
