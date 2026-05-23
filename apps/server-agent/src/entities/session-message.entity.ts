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
export class SessionMessage {
  /** 与 checkpointer / pending_messages.id 对齐。 */
  @PrimaryColumn()
  id!: string;

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

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
