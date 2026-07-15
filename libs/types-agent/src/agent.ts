import { z } from "zod";
import { QUICK_ASSISTANT_NAME_MAX } from "./quick-assistant";

/** 默认 Agent 的名字（账号下零 agent 时自动创建）。 */
export const DEFAULT_AGENT_NAME = "M";

/** 默认 Agent 的头像：`emoji|背景色` 两段式，前端拆开渲染。 */
export const DEFAULT_AGENT_AVATAR = "🤖|#f97316";

/** 远程可见性。本期恒 private，org 为云端注册（计划二）预留。 */
export const AgentVisibilitySchema = z.enum(["private", "org"]);

/**
 * 创建 Agent 的入参。
 *
 * `name` 上限复用 `QUICK_ASSISTANT_NAME_MAX`（原为独立的 max(32)）——
 * rename-agent 工具 / 随手问改名口都已对齐这个常量（见 bfb671d0），
 * 通用 Agent 编辑器若各走一套上限，同一个 `agent.name` 字段会出现
 * "编辑器存的了、工具改不了"的口径分裂。
 */
export const AgentCreateSchema = z.object({
  name: z.string().trim().min(1).max(QUICK_ASSISTANT_NAME_MAX),
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

/**
 * Agent 的 mcp.json 原始文本读写载体。前端编辑器直接读写整份 JSON 字符串，
 * 落盘前经 `libs/agent` 的 `McpConfigSchema` 二次校验（这里只保证是个字符串）。
 */
export const McpRawSchema = z.object({
  raw: z.string(),
});

export type AgentVisibility = z.infer<typeof AgentVisibilitySchema>;
export type AgentCreateInput = z.infer<typeof AgentCreateSchema>;
export type AgentUpdateInput = z.infer<typeof AgentUpdateSchema>;
export type AgentView = z.infer<typeof AgentViewSchema>;
export type McpRawInput = z.infer<typeof McpRawSchema>;
