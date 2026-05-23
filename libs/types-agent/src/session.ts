import { z } from "zod";

/** 会话状态：idle = 无 run；running = 有 run 在跑。 */
export const SessionStatus = z.enum(["idle", "running"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** 待处理用户消息状态。 */
export const PendingMessageStatus = z.enum([
  "pending",
  "processing",
  "processed",
  "failed",
]);
export type PendingMessageStatus = z.infer<typeof PendingMessageStatus>;

/** POST /api/sessions 入参。 */
export const CreateSessionSchema = z.object({
  content: z.string().min(1),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

/**
 * POST /api/sessions/:id/messages 入参。
 *
 * `messageId` 由前端生成（UUID）：让前端在乐观插入 user 气泡时就拿到最终 id，
 * 避免 run.human 早于 append 200 返回时找不到目标气泡。后端只校验长度（不强约束
 * 格式）+ 写 pending_messages 表 + 作为 HumanMessage.id 入 checkpointer，三方对齐。
 */
export const AppendMessageSchema = z.object({
  messageId: z.string().min(1),
  content: z.string().min(1),
});
export type AppendMessageInput = z.infer<typeof AppendMessageSchema>;

/** 会话历史中的一条消息（来自 LangGraph checkpointer）。 */
export const HistoryMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  /** 推理模型的思考过程（持久化在 checkpointer 的 additional_kwargs.reasoning_content）。 */
  reasoning: z.string().optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/** 当前未完成 assistant 消息快照。 */
export const InflightSnapshotSchema = z.object({
  messageId: z.string().nullable(),
  content: z.string(),
  status: z.enum(["streaming", "done", "interrupted"]),
});
export type InflightSnapshot = z.infer<typeof InflightSnapshotSchema>;

/** 排队中的用户消息。 */
export const PendingMessageDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  content: z.string(),
  status: PendingMessageStatus,
  createdAt: z.string(),
});
export type PendingMessageDto = z.infer<typeof PendingMessageDtoSchema>;

/** 一次 LLM 调用的 token 明细（跨供应商统一字段；供应商不上报的项为 0）。 */
const TokenBreakdownSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  reasoningTokens: z.number(),
});

/** 单条 assistant 消息对应一次 LLM 调用的用量。 */
export const MessageUsageSchema = TokenBreakdownSchema.extend({
  providerType: z.string(),
  model: z.string(),
  durationMs: z.number(),
});
export type MessageUsage = z.infer<typeof MessageUsageSchema>;

/** 会话累计：所有 LLM 调用的求和。 */
export const SessionTotalsSchema = TokenBreakdownSchema.extend({
  callCount: z.number(),
});
export type SessionTotals = z.infer<typeof SessionTotalsSchema>;

/** 会话 usage 聚合 —— history 接口与前端 atom 共用。 */
export const SessionUsageSchema = z.object({
  sessionTotals: SessionTotalsSchema,
  byMessage: z.record(z.string(), MessageUsageSchema),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/** GET /api/sessions/:id/history 查询参数。 */
export const HistoryQuerySchema = z.object({
  /** Cursor：上一批最早消息的 id；不传 = 拉最新一批。 */
  before: z.string().optional(),
  /** 每页条数，默认 50，硬上限 200。 */
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

/**
 * GET /api/sessions/:id/history 出参。
 *
 * cursor 分页：messages 按 createdAt asc，hasMore 表示老消息是否还有。
 * 仅首次（before 未传）返 inflight + sessionTotals；翻页时不返。byMessage
 * 始终是本批 messages 对应的 LLM usage 投影，前端合并到 atom。
 */
export const HistoryResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
  hasMore: z.boolean(),
  inflight: InflightSnapshotSchema.nullable(),
  sessionTotals: SessionTotalsSchema.optional(),
  byMessage: z.record(z.string(), MessageUsageSchema),
});
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

/** GET /api/sessions/:id/pending 出参。 */
export const PendingResponseSchema = z.object({
  pending: z.array(PendingMessageDtoSchema),
});
export type PendingResponse = z.infer<typeof PendingResponseSchema>;

/** socket: run.chunk 事件载荷。 */
export const RunChunkEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  delta: z.string(),
});
export type RunChunkEvent = z.infer<typeof RunChunkEventSchema>;

/**
 * socket: run.reasoning 事件载荷。
 *
 * 推理模型（DeepSeek v4-pro 等）在吐 content 前先逐 token 推送 reasoning_content。
 * 前端把它累加到 assistant 气泡的折叠区，默认收起，点击「已思考 Xs」可展开。
 * 不落库，刷页就没。
 */
export const RunReasoningChunkEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  delta: z.string(),
});
export type RunReasoningChunkEvent = z.infer<
  typeof RunReasoningChunkEventSchema
>;

/** socket: run.done 事件载荷。 */
export const RunDoneEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  content: z.string(),
});
export type RunDoneEvent = z.infer<typeof RunDoneEventSchema>;

/** socket: run.interrupted 事件载荷。 */
export const RunInterruptedEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});
export type RunInterruptedEvent = z.infer<typeof RunInterruptedEventSchema>;

/** socket: run.error 事件载荷。 */
export const RunErrorEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string().nullable(),
  /** 出错批次的用户 PendingMessage id —— 流前出错（messageId 为 null）时供前端定位失败气泡。 */
  pendingIds: z.array(z.string()),
  error: z.string(),
});
export type RunErrorEvent = z.infer<typeof RunErrorEventSchema>;

/**
 * socket: run.human 事件载荷。
 *
 * runner 把一条 user 消息以 HumanMessage 形式写入 checkpointer 时立即 emit。
 * 前端据此把对应 user 气泡从 pending 区迁出，按事件到达顺序重排到聊天区末尾
 * （在该批 chunk/done 之前），保证 user → assistant 的视觉时序一致。
 */
export const RunHumanEventSchema = z.object({
  sessionId: z.string(),
  /** 与 pending_messages.id / checkpointer HumanMessage.id 三方对齐。 */
  messageId: z.string(),
});
export type RunHumanEvent = z.infer<typeof RunHumanEventSchema>;

/** socket: run.usage 事件载荷（单条 LLM 调用完成）。 */
export const RunUsageEventSchema = MessageUsageSchema.extend({
  sessionId: z.string(),
  messageId: z.string(),
});
export type RunUsageEvent = z.infer<typeof RunUsageEventSchema>;

/**
 * DELETE /api/sessions/:sessionId/pending-messages/:messageId 响应载荷。
 * 返回 content 让前端在「编辑」场景下回填输入框。
 */
export const DeletePendingResponseSchema = z.object({
  deleted: z.literal(true),
  content: z.string(),
});
export type DeletePendingResponse = z.infer<typeof DeletePendingResponseSchema>;

/** socket: 客户端 session.subscribe / session.interrupt 入参。 */
export const SessionTopicSchema = z.object({ sessionId: z.string() });
export type SessionTopic = z.infer<typeof SessionTopicSchema>;

/** POST /api/sessions/:id/retry 出参。 */
export const RetryResponseSchema = z.object({
  retried: z.boolean(),
});
export type RetryResponse = z.infer<typeof RetryResponseSchema>;

/** WS namespace 与事件名常量。 */
export const SESSION_WS_NAMESPACE = "ws/session";
export const SESSION_WS_EVENTS = {
  subscribe: "session.subscribe",
  interrupt: "session.interrupt",
  runHuman: "run.human",
  runReasoning: "run.reasoning",
  runChunk: "run.chunk",
  runDone: "run.done",
  runInterrupted: "run.interrupted",
  runError: "run.error",
  runUsage: "run.usage",
} as const;
