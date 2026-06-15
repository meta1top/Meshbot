import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from "typeorm";

/**
 * 会话消息表（append-only，永不删）。
 *
 * 用作展示反面：与 LangGraph checkpointer 解耦，未来 LLM context 被 summarize
 * 压缩时不影响这里。所有 user / assistant / tool 消息都进此表。
 *
 * id 与 checkpointer 里 HumanMessage / AIMessage 的 id 对齐（user 消息亦是
 * pending_messages.id），三方一致便于关联查询和前后端去重。
 */
@Entity("session_messages")
@Index(["sessionId", "createdAt", "id"])
@Index(["sessionId", "seq"])
export class SessionMessage {
  /** 与 checkpointer / pending_messages.id 对齐。 */
  @PrimaryColumn()
  id!: string;

  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  /**
   * 会话内单调递增序号（1-based）。唯一可靠排序键：
   * INSERT 时由 `(SELECT COALESCE(MAX(seq),0)+1 WHERE session_id=?)` 原子赋值。
   * createdAt 仅保留作活跃度统计 / 时间展示，不再用于排序（会同毫秒碰撞、
   * 退化为随机 UUID tie-break → 批量注入消息刷新后时序错乱）。
   */
  @Column({ type: "integer", default: 0 })
  seq!: number;

  /** 逻辑外键，无 DB 约束。 */
  @Column({ name: "session_id" })
  sessionId!: string;

  /** "user" | "assistant" | "system" | "tool"；本次仅 user/assistant 写入。 */
  @Column({ type: "varchar" })
  role!: "user" | "assistant" | "system" | "tool";

  @Column({ type: "text" })
  content!: string;

  /** 推理模型的思考过程（DeepSeek 等）；非推理 / 工具消息为 null。 */
  @Column({ type: "text", nullable: true })
  reasoning!: string | null;

  /** 工具调用参数（JSON-string），assistant 调工具时填；本次预留。 */
  @Column({ name: "tool_calls", type: "text", nullable: true })
  toolCalls!: string | null;

  /** tool role 时关联到上游 assistant 的某条 tool_call id；本次预留。 */
  @Column({ name: "tool_call_id", type: "varchar", nullable: true })
  toolCallId!: string | null;

  /**
   * 元信息 JSON 字符串。普通消息为 null。
   *
   * Compaction 占位行 metadata 形如：
   *   { kind: "compaction", removedCount: 12, fromMessageId, toMessageId }
   * 摘要文本本身落在 `content` 字段，不重复进 metadata。
   *
   * 解析责任在调用方（service 读出后 JSON.parse；写入前 JSON.stringify）。
   */
  @Column({ type: "text", nullable: true })
  metadata!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
