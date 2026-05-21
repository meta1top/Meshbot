import { z } from "zod";

/** 会话状态：idle = 无 run；running = 有 run 在跑。 */
export const SessionStatus = z.enum(["idle", "running"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** 待处理用户消息状态。 */
export const PendingMessageStatus = z.enum([
  "pending",
  "processing",
  "processed",
]);
export type PendingMessageStatus = z.infer<typeof PendingMessageStatus>;

/** POST /api/sessions 入参。 */
export const CreateSessionSchema = z.object({
  content: z.string().min(1),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

/** POST /api/sessions/:id/messages 入参。 */
export const AppendMessageSchema = z.object({
  content: z.string().min(1),
});
export type AppendMessageInput = z.infer<typeof AppendMessageSchema>;

/** 会话历史中的一条消息（来自 LangGraph checkpointer）。 */
export const HistoryMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
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

/** GET /api/sessions/:id/history 出参。 */
export const HistoryResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
  inflight: InflightSnapshotSchema.nullable(),
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
  error: z.string(),
});
export type RunErrorEvent = z.infer<typeof RunErrorEventSchema>;

/** socket: 客户端 session.subscribe / session.interrupt 入参。 */
export const SessionTopicSchema = z.object({ sessionId: z.string() });
export type SessionTopic = z.infer<typeof SessionTopicSchema>;

/** WS namespace 与事件名常量。 */
export const SESSION_WS_NAMESPACE = "ws/session";
export const SESSION_WS_EVENTS = {
  subscribe: "session.subscribe",
  interrupt: "session.interrupt",
  runChunk: "run.chunk",
  runDone: "run.done",
  runInterrupted: "run.interrupted",
  runError: "run.error",
} as const;
