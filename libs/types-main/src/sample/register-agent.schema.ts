import { z } from "zod";

/**
 * Sample schema —— 验证 Zod 分层 + createZodDto 工作流。
 * Phase 3 server-main 起步时由真实 Agent 注册 schema 替换。
 */
export const RegisterAgentSchema = z.object({
  agentId: z.string().uuid(),
  deviceName: z.string().min(1).max(64),
  capabilities: z.array(z.string()).default([]),
});

export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;
