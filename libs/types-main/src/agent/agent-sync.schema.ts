import { z } from "zod";

/**
 * 设备侧全量推送 remote_enabled Agent 元数据(单条)。
 * 供 AgentService.syncForDeviceInTx 对账入参与 T2 注册 REST DTO 复用。
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
