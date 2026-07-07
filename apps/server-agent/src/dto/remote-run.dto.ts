import { createI18nZodDto } from "@meshbot/common";
import { z } from "zod";

/**
 * L3 远程 run HTTP DTO：本地定义（streamId/targetDeviceId 分别由服务端生成 /
 * 路径参数提供，不在请求体里，无法直接复用 `@meshbot/types` 的
 * `AgentRunStartSchema`/`AgentRunControlSchema`——那两个是 relay 上行的完整
 * 线路层 schema）。
 */

/** POST /remote-devices/:id/run 请求体：mode 决定目标设备新建 / 续写会话。 */
export const RemoteRunSchema = z.object({
  mode: z.enum(["create", "append"]),
  sessionId: z.string().min(1).optional(),
  content: z.string().min(1),
});
export type RemoteRunInput = z.infer<typeof RemoteRunSchema>;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RemoteRunDto extends createI18nZodDto(RemoteRunSchema) {}
export interface RemoteRunDto extends RemoteRunInput {}

/** POST /remote-devices/:id/run/interrupt 请求体：指定要中断的 streamId + B 侧会话 id。 */
export const RemoteInterruptSchema = z.object({
  streamId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type RemoteInterruptInput = z.infer<typeof RemoteInterruptSchema>;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RemoteInterruptDto extends createI18nZodDto(
  RemoteInterruptSchema,
) {}
export interface RemoteInterruptDto extends RemoteInterruptInput {}
