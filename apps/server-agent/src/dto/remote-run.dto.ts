import { createI18nZodDto } from "@meshbot/common";
import { z } from "zod";

/**
 * L3 远程 run HTTP DTO：本地定义（streamId/targetAgentId 分别由服务端生成 /
 * 路径参数提供，不在请求体里，无法直接复用 `@meshbot/types` 的
 * `AgentRunStartSchema`/`AgentRunControlSchema`——那两个是 relay 上行的完整
 * 线路层 schema）。
 */

/** POST /remote-agents/:agentId/run 请求体：mode 决定目标 Agent 新建 / 续写会话。 */
export const RemoteRunSchema = z.object({
  mode: z.enum(["create", "append"]),
  sessionId: z.string().min(1).optional(),
  content: z.string().min(1),
});
export type RemoteRunInput = z.infer<typeof RemoteRunSchema>;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RemoteRunDto extends createI18nZodDto(RemoteRunSchema) {}
export interface RemoteRunDto extends RemoteRunInput {}

/** POST /remote-agents/:agentId/run/interrupt 请求体：指定要中断的 streamId + B 侧会话 id。 */
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

/**
 * POST /remote-agents/:agentId/run/confirm 请求体：提交工具确认（im_send /
 * drive_share / drive_create_share）。
 *
 * `streamId`/`watchId` 二选一必填（Task 16b：观察者经本机 server-agent 代理
 * 应答别人发起的 run 挂起的 HITL 关卡，本地没有 streamId，回退传 watchId——
 * 即 `POST .../watch` 签发的 session 级观察通道 id）。镜像 relay 线路层
 * `AgentRunControlSchema` 的双寻址约束（libs/types/src/im/im.schema.ts），
 * 这里就地重复一份是因为本文件顶部注释已明确的理由：A 侧 HTTP 请求体是
 * 独立定义，不直接复用那份线路层 schema。
 */
export const RemoteConfirmSchema = z
  .object({
    streamId: z.string().min(1).optional(),
    watchId: z.string().min(1).optional(),
    sessionId: z.string().min(1),
    toolCallId: z.string().min(1),
    decision: z.enum(["send", "cancel"]),
    content: z.string().optional(),
  })
  .refine((v) => !!v.streamId !== !!v.watchId, {
    message: "streamId 与 watchId 二选一必填",
  });
export type RemoteConfirmInput = z.infer<typeof RemoteConfirmSchema>;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RemoteConfirmDto extends createI18nZodDto(RemoteConfirmSchema) {}
export interface RemoteConfirmDto extends RemoteConfirmInput {}

/**
 * 远程 ask_question 回答项。本地就地定义（不复用 `@meshbot/types` 的
 * `AgentRunAnswerItemSchema`——那是 relay 上行的线路层 schema，此处是 A 侧
 * HTTP 请求体，两者形状须保持一致但归属不同层）。
 */
export const RemoteAnswerItemSchema = z.object({
  selected: z.array(z.string()),
  other: z.string().optional(),
});

/**
 * POST /remote-agents/:agentId/run/answer 请求体：提交 ask_question 回答。
 *
 * `streamId`/`watchId` 二选一必填（Task 16b，理由同 {@link RemoteConfirmSchema}）。
 */
export const RemoteAnswerSchema = z
  .object({
    streamId: z.string().min(1).optional(),
    watchId: z.string().min(1).optional(),
    sessionId: z.string().min(1),
    toolCallId: z.string().min(1),
    answers: z.array(RemoteAnswerItemSchema),
  })
  .refine((v) => !!v.streamId !== !!v.watchId, {
    message: "streamId 与 watchId 二选一必填",
  });
export type RemoteAnswerInput = z.infer<typeof RemoteAnswerSchema>;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RemoteAnswerDto extends createI18nZodDto(RemoteAnswerSchema) {}
export interface RemoteAnswerDto extends RemoteAnswerInput {}

/** GET /remote-agents/:agentId/runs 查询参数：streamId 或 sessionId 至少其一。 */
export const RemoteRunsQuerySchema = z
  .object({
    streamId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .refine((v) => !!v.streamId || !!v.sessionId, {
    message: "streamId 或 sessionId 至少其一",
  });
export type RemoteRunsQueryInput = z.infer<typeof RemoteRunsQuerySchema>;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RemoteRunsQueryDto extends createI18nZodDto(
  RemoteRunsQuerySchema,
) {}
export interface RemoteRunsQueryDto extends RemoteRunsQueryInput {}

/** PATCH /remote-agents/:agentId/sessions/:sessionId/model 请求体。 */
export const RemotePatchSessionModelSchema = z.object({
  modelConfigId: z.string().min(1),
});
export type RemotePatchSessionModelInput = z.infer<
  typeof RemotePatchSessionModelSchema
>;

export class RemotePatchSessionModelDto extends createI18nZodDto(
  RemotePatchSessionModelSchema,
) {}
export interface RemotePatchSessionModelDto
  extends RemotePatchSessionModelInput {}

/**
 * POST /remote-agents/:agentId/watch 请求体（Task 18：web-agent 经本机
 * server-agent 代理发起 Agent 级观察）。本地就地定义（不复用 `@meshbot/types`
 * 的 `AgentWatchStartSchema`——那个还带 watchId/targetAgentId，此处 watchId 由
 * 服务端生成、targetAgentId 是路径参数，两者都不在请求体里）。
 */
export const RemoteWatchStartSchema = z
  .object({
    scope: z.enum(["agent", "session"]),
    /** scope="session" 时必填：被观察会话在目标设备上的 id。 */
    sessionId: z.string().min(1).optional(),
  })
  .refine((v) => v.scope !== "session" || !!v.sessionId, {
    message: "scope=session 必须携带 sessionId",
    path: ["sessionId"],
  });
export type RemoteWatchStartInput = z.infer<typeof RemoteWatchStartSchema>;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RemoteWatchStartDto extends createI18nZodDto(
  RemoteWatchStartSchema,
) {}
export interface RemoteWatchStartDto extends RemoteWatchStartInput {}
