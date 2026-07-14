import { z } from "zod";

/** 会话状态：idle = 无 run；running = 有 run 在跑。 */
export const SessionStatus = z.enum(["idle", "running"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** 侧边栏 + 创会话接口共用的会话概要。 */
export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: SessionStatus,
  /** 派生：pinnedAt != null。客户端用做语义判断，避免每处都比较 pinnedAt。 */
  pinned: z.boolean(),
  /** ISO datetime；非 null 即已固定，值用于客户端排序与未来重排。 */
  pinnedAt: z.string().datetime().nullable(),
  /**
   * 是否「有过明确标题」：LLM 自动生成成功 或 用户手动改过。
   * false = title 仍是创会话时的「首条前 30 字」fallback。
   */
  titleGenerated: z.boolean(),
  /** 会话绑定的模型配置 id；null = 走账号默认（首个 enabled）。 */
  modelConfigId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** GET /api/sessions 出参。 */
export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

/**
 * PATCH /api/sessions/:id 入参。title / pinned 至少传一个。
 * - pinned=true 会写当前时间到 pinned_at（最近固定的排到顶）。
 * - pinned=false 会把 pinned_at 置 null。
 */
export const SessionPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    /** 切换会话模型（下一条消息生效）；须为当前账号存在的 ModelConfig id。 */
    modelConfigId: z.string().optional(),
  })
  .refine(
    (d) =>
      d.title !== undefined ||
      d.pinned !== undefined ||
      d.modelConfigId !== undefined,
    { message: "至少传 title / pinned / modelConfigId 之一" },
  );
export type SessionPatchInput = z.infer<typeof SessionPatchSchema>;

/** DELETE /api/sessions/:id 出参。 */
export const SessionDeleteResponseSchema = z.object({
  deleted: z.literal(true),
});
export type SessionDeleteResponse = z.infer<typeof SessionDeleteResponseSchema>;

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
  /** "quick" = 随手问临时会话（不进侧栏）；缺省 "user"。 */
  kind: z.enum(["user", "quick"]).optional(),
  /** 会话使用的模型配置 id；缺省走账号默认（首个 enabled）。 */
  modelConfigId: z.string().optional(),
  /** 会话归属的 Agent id；缺省由 Controller 兜底取账号默认 Agent（ensureDefault）。 */
  agentId: z.string().optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

/**
 * POST /api/sessions 出参。兼容老调用方：保留顶层 sessionId 不变，追加 session
 * 字段，前端用 session 完整对象插入 sessionsAtom（无需二次 GET）。
 */
export const CreateSessionResponseSchema = z.object({
  sessionId: z.string(),
  session: SessionSummarySchema,
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

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

/** 历史 ReAct 轨迹中的单次工具调用。 */
export const HistoryToolCallSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  status: z.enum(["ok", "error", "running"]),
  result: z.string(),
  /**
   * dispatch_subagent 专用：该次调用派生的子会话 id。后端组装 history 时按
   * parent_tool_call_id 反查带出，供前端嵌套卡在任意时刻（含子 run 进行中刷新）
   * 认领。其他工具无此字段。
   */
  subSessionId: z.string().optional(),
});
export type HistoryToolCall = z.infer<typeof HistoryToolCallSchema>;

/** 会话历史中的一条消息（来自 LangGraph checkpointer）。 */
export const HistoryMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  /** 推理模型的思考过程（持久化在 checkpointer 的 additional_kwargs.reasoning_content）。 */
  reasoning: z.string().optional(),
  toolCalls: z.array(HistoryToolCallSchema).optional(),
  /**
   * 结构化附加元数据（JSON 反序列化后）。压缩占位行携带 kind="compaction" 以供前端
   * 渲染 CompactionRow 替代普通系统消息。
   */
  metadata: z
    .object({
      kind: z.literal("compaction"),
      removedCount: z.number(),
      fromMessageId: z.string(),
      toMessageId: z.string(),
    })
    .nullable()
    .optional(),
  /** assistant 消息反馈（点赞/不喜欢）；其余为 null/缺省。 */
  feedback: z.enum(["up", "down"]).nullable().optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/** 消息反馈：点赞 up / 不喜欢 down / 取消 null。 */
export const MessageFeedbackSchema = z.object({
  feedback: z.enum(["up", "down"]).nullable(),
});
export type MessageFeedbackInput = z.infer<typeof MessageFeedbackSchema>;

/**
 * inflight 中「args 正在流式生成」的工具调用快照。
 *
 * tool_call args 是逐 token 流出来的，中途订阅者只能收到剩余尾巴片段——单靠尾巴
 * 拼不出合法 JSON，工具卡只能空转到 run.tool_call_start 整包补齐才突然出现。
 * 快照把「已经流过去的 args 前缀」补给新订阅者，后续增量再 append 就能接上。
 */
export const InflightToolCallSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  /** 已累计的 args JSON 片段（流式中途，通常未闭合）。 */
  argsText: z.string(),
});
export type InflightToolCall = z.infer<typeof InflightToolCallSchema>;

/** 当前未完成 assistant 消息快照。 */
export const InflightSnapshotSchema = z.object({
  messageId: z.string().nullable(),
  content: z.string(),
  /** 本轮 args 流式中的工具调用；已落库轮 / 无工具时为空数组。 */
  toolCalls: z.array(InflightToolCallSchema),
  /** 已累积的 reasoning（思考过程），无则空串。 */
  reasoning: z.string(),
  /**
   * 当前轮 reasoning 首个 chunk 到达的时间戳（ms）；无 reasoning 时为 null。
   * 前端刷新时用此值恢复「思考中 Xs」计时器，避免从刷新时刻起算。
   */
  reasoningStartedAt: z.number().nullable(),
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
  /**
   * 该消息是否已落入 session_messages（历史）。
   * 前端据此区分：已入库的 failed/processing 由历史在正确 seq 位置展示，不再
   * 追加到时间线末尾（修复"失败消息堆在底部"——历史分页时首页 id 集合不全）；
   * 未入库的（如 run.human 前就失败的孤儿消息）才追加。
   */
  inHistory: z.boolean(),
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
  /** 调用时的模型配置显示名快照——改名/删除后历史仍显示当时名称；快照前的历史行无。 */
  modelName: z.string().optional(),
  durationMs: z.number(),
});
export type MessageUsage = z.infer<typeof MessageUsageSchema>;

/** 会话累计：所有 LLM 调用的求和。 */
export const SessionTotalsSchema = TokenBreakdownSchema.extend({
  callCount: z.number(),
  /** 最近一次 LLM 调用的 input_tokens；空 session = 0。用于进度环显示「下次请求估算 / ctx 上限」。 */
  lastInputTokens: z.number(),
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
 * socket: run.snapshot 事件载荷（subscribe 回放专用，SET 语义）。
 *
 * 订阅时若有活 inflight，gateway 一次性发本轮全量 reasoning/content/startedAt；
 * 前端按 messageId **覆盖**（非累加）该气泡，与 HTTP inflight push 互为幂等，
 * 根治「push + run.reasoning/run.chunk 回放叠加 / 断线重连」的文本翻倍。
 * 后续真正的增量仍走 run.reasoning / run.chunk（append）。
 */
export const RunSnapshotEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  reasoning: z.string(),
  content: z.string(),
  reasoningStartedAt: z.number().nullable(),
  /** 本轮 args 流式中的工具调用（见 InflightToolCallSchema）。 */
  toolCalls: z.array(InflightToolCallSchema),
});
export type RunSnapshotEvent = z.infer<typeof RunSnapshotEventSchema>;

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

/**
 * socket: run.reasoning_done 事件载荷。
 *
 * 本轮 LLM 第一次出现非空 tool_calls 时触发——意味着 reasoning_content 阶段
 * 已结束、模型转入 tool_calls token 流。前端据此锁定 reasoningDurationMs，
 * 让「思考中 Xs」尽早切到「已思考 Xs」，不再把 tool_calls token 的几秒流
 * 算进思考时间。
 *
 * 对 content-having 轮（无 tool_calls）：此事件不触发；onChunk 已处理锁定。
 */
export const RunReasoningDoneEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});
export type RunReasoningDoneEvent = z.infer<typeof RunReasoningDoneEventSchema>;

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
  /**
   * 该 user 消息正文。前端有乐观气泡时（用户手动发送）按 id 迁移即可，忽略此字段；
   * 服务端注入的消息（如定时任务触发）前端没有乐观气泡，需据此新建气泡。
   */
  content: z.string(),
});
export type RunHumanEvent = z.infer<typeof RunHumanEventSchema>;

/** socket: run.usage 事件载荷（单条 LLM 调用完成）。 */
export const RunUsageEventSchema = MessageUsageSchema.extend({
  sessionId: z.string(),
  messageId: z.string(),
});
export type RunUsageEvent = z.infer<typeof RunUsageEventSchema>;

/** socket: run.tool_call_start —— tool 即将开始执行。 */
export const RunToolCallStartEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
});
export type RunToolCallStartEvent = z.infer<typeof RunToolCallStartEventSchema>;

/** socket: run.tool_call_progress —— tool 执行中的增量输出（如 bash stdout）。 */
export const RunToolCallProgressEventSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  delta: z.string(),
});
export type RunToolCallProgressEvent = z.infer<
  typeof RunToolCallProgressEventSchema
>;

/**
 * socket: run.tool_call_args_delta —— LLM 生成某个 tool_call 参数 JSON 的增量。
 * 纯瞬态（不落库），供前端流式「实时预览」工具参数（write/edit/bash 等）。
 *
 * `toolCallId` 是该 tool_call 的稳定 id（与随后的 run.tool_call_start 同源）：
 * 前端据此把增量合并到「同一个工具块」上（像 chunk 按 messageId 合并到消息），
 * 流式 args → running → 完成 一气呵成，不再先建预览块再整批清空。
 * 个别 provider 流里不带 id 时缺省 undefined，前端跳过该轮流式预览、等 start。
 * `index` 仅作同轮内序号备用（id 缺失时的兜底定位）。
 */
export const RunToolCallArgsDeltaEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string().optional(),
  index: z.number().int(),
  name: z.string().optional(),
  delta: z.string(),
});
export type RunToolCallArgsDeltaEvent = z.infer<
  typeof RunToolCallArgsDeltaEventSchema
>;

/**
 * Tool 执行结束（成功/失败）。
 *
 * - `resultPreview`：前 200 字符摘要，前端显示。
 * - `content`：完整 result 字符串，runner 落库用；**gateway 转发前剥掉**，
 *   不上 socket 线。
 */
export const RunToolCallEndEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  resultPreview: z.string(),
  content: z.string(),
});
export type RunToolCallEndEvent = z.infer<typeof RunToolCallEndEventSchema>;

/** 子 Agent 派发关联事件：让前端把父消息里某个 dispatch 工具卡认领到子会话。 */
export interface RunSubagentSpawnedEvent {
  /** 父会话 id（事件按此路由到父房间）。 */
  sessionId: string;
  /** 父会话里那次 dispatch 工具调用的 toolCallId。 */
  toolCallId: string;
  /** 子会话 id（前端据此订阅嵌套流）。 */
  subSessionId: string;
  /** 子任务短标题。 */
  description: string;
}

/** 子 Agent 了结事件：后台子任务终态回传，前端把 dispatch 卡更新为终态。 */
export interface RunSubagentSettledEvent {
  /** 父会话 id（事件按此路由到父房间）。 */
  sessionId: string;
  /** 父会话里那次 dispatch 工具调用的 toolCallId。 */
  toolCallId: string;
  /** 子会话 id。 */
  subSessionId: string;
  /** 子 run 终态。 */
  status: "done" | "error" | "aborted";
  /** 终态输出（已截断），与重写后的工具结果 JSON 一致。 */
  output: string;
}

/** socket: run.compaction_start —— 压缩开始通知。 */
export const RunCompactionStartEventSchema = z.object({
  sessionId: z.string(),
  /** "threshold" = pre-check 触发；"ctx-exceeded" = LLM 报错后兜底触发。 */
  reason: z.enum(["threshold", "ctx-exceeded"]),
});
export type RunCompactionStartEvent = z.infer<
  typeof RunCompactionStartEventSchema
>;

/** socket: run.compaction_done —— 压缩完成。 */
export const RunCompactionDoneEventSchema = z.object({
  sessionId: z.string(),
  /** 被压缩进摘要的原 messages 条数。 */
  removedCount: z.number(),
  /** 摘要文本的前 200 字预览，便于前端 banner 顺手展示。 */
  summaryPreview: z.string(),
});
export type RunCompactionDoneEvent = z.infer<
  typeof RunCompactionDoneEventSchema
>;

/** socket: run.compaction_error —— 压缩失败。 */
export const RunCompactionErrorEventSchema = z.object({
  sessionId: z.string(),
  error: z.string(),
});
export type RunCompactionErrorEvent = z.infer<
  typeof RunCompactionErrorEventSchema
>;

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

/**
 * socket: session.title_updated —— SessionTitleService 后台 LLM 生成完成。
 * Gateway namespace 广播；前端 sidebar / sessions atom 局部更新 title。
 */
export const SessionTitleUpdatedEventSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
});
export type SessionTitleUpdatedEvent = z.infer<
  typeof SessionTitleUpdatedEventSchema
>;

/** WS namespace 与事件名常量。 */
export const SESSION_WS_NAMESPACE = "ws/session";
export const SESSION_WS_EVENTS = {
  subscribe: "session.subscribe",
  unsubscribe: "session.unsubscribe",
  interrupt: "session.interrupt",
  titleUpdated: "session.title_updated",
  runHuman: "run.human",
  runReasoning: "run.reasoning",
  runReasoningDone: "run.reasoning_done",
  runChunk: "run.chunk",
  runSnapshot: "run.snapshot",
  runDone: "run.done",
  runInterrupted: "run.interrupted",
  runError: "run.error",
  runUsage: "run.usage",
  runToolCallStart: "run.tool_call_start",
  runToolCallProgress: "run.tool_call_progress",
  runToolCallArgsDelta: "run.tool_call_args_delta",
  runToolCallEnd: "run.tool_call_end",
  runCompactionStart: "run.compaction_start",
  runCompactionDone: "run.compaction_done",
  runCompactionError: "run.compaction_error",
  runSubagentSpawned: "run.subagent_spawned",
  runSubagentSettled: "run.subagent_settled",
} as const;
