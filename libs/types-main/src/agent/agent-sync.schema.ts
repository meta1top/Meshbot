import { z } from "zod";

/**
 * 设备侧全量推送 remote_enabled Agent 元数据(单条)。
 * 供 CloudAgentService.syncForDevice 对账入参与 T2 注册 REST DTO 复用。
 */
export const AgentSyncItemSchema = z.object({
  localAgentId: z
    .string()
    .min(1, { message: "validation.required" })
    .max(20, { message: "validation.stringTooLong" }),
  name: z
    .string()
    .min(1, { message: "validation.required" })
    .max(128, { message: "validation.stringTooLong" }),
  avatar: z.string().max(64, { message: "validation.stringTooLong" }),
  description: z
    .string()
    .max(2000, { message: "validation.stringTooLong" })
    .nullable(),
  visibility: z.string().max(16, { message: "validation.stringTooLong" }),
});
export type AgentSyncInput = z.infer<typeof AgentSyncItemSchema>;

/** 设备侧全量推送：本次同步的完整 Agent 列表。 */
export const AgentSyncRequestSchema = z.object({
  items: z.array(AgentSyncItemSchema),
});
export type AgentSyncRequest = z.infer<typeof AgentSyncRequestSchema>;

/**
 * T2 注册 REST 的批量 body（`PUT /api/agent/agents`）。
 *
 * `superRefine` 双保险：批次内 localAgentId 必须唯一。CloudAgentService.syncForDevice
 * 虽然会按 localAgentId 去重（保留最后一条），但重复本身多半是调用方 bug，
 * 且唯一索引 `uq_agent_device_local` 也在兜底——在入口用 Zod 拒掉，让错误就近暴露
 * 而非被静默吞掉或延后到写库时裸抛 Postgres 异常。
 */
export const AgentSyncBatchSchema = z.object({
  agents: z.array(AgentSyncItemSchema).superRefine((agents, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < agents.length; i++) {
      const id = agents[i].localAgentId;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "validation.duplicate",
          path: [i, "localAgentId"],
        });
      }
      seen.add(id);
    }
  }),
});
export type AgentSyncBatch = z.infer<typeof AgentSyncBatchSchema>;

/** web-main 列表视图：云端 agent 对外呈现（含云端主键 id 供网关寻址）。 */
export const AgentViewSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  localAgentId: z.string(),
  name: z.string(),
  avatar: z.string(),
  description: z.string().nullable(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;
