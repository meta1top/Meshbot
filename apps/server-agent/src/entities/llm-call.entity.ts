import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

/** epoch ms ↔ Date transformer，使 SQLite integer 列可与 Date 对象互转。 */
const epochMsTransformer = {
  to: (value: Date | number | undefined): number =>
    value instanceof Date ? value.getTime() : (value ?? Date.now()),
  from: (value: number | null): Date =>
    value !== null ? new Date(value) : new Date(),
};

/**
 * 一次 LLM 调用的观测记录。
 *
 * 每次 supervisor 节点跑完 model.stream 落一行；用于会话累计 token 与
 * 单条消息的 token 明细（前端展示 + 后期成本分析）。失败 run 不记录。
 */
@Entity("llm_calls")
export class LlmCall {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** 逻辑外键，无 DB 约束。 */
  @Column({ name: "session_id" })
  sessionId!: string;

  /** LangGraph AIMessage id，与 checkpointer assistant 消息对齐。 */
  @Column({ name: "message_id" })
  messageId!: string;

  @Column({ name: "provider_type", type: "varchar" })
  providerType!: string;

  @Column({ type: "varchar" })
  model!: string;

  @Column({ name: "input_tokens", type: "integer", default: 0 })
  inputTokens!: number;

  @Column({ name: "output_tokens", type: "integer", default: 0 })
  outputTokens!: number;

  @Column({ name: "total_tokens", type: "integer", default: 0 })
  totalTokens!: number;

  /** 缓存命中（低价）的 input tokens；供应商不上报则为 0。 */
  @Column({ name: "cache_read_tokens", type: "integer", default: 0 })
  cacheReadTokens!: number;

  /** 缓存首次写入的 input tokens；供应商不上报则为 0。 */
  @Column({ name: "cache_creation_tokens", type: "integer", default: 0 })
  cacheCreationTokens!: number;

  /** 推理（thinking）tokens；供应商不上报则为 0。 */
  @Column({ name: "reasoning_tokens", type: "integer", default: 0 })
  reasoningTokens!: number;

  @Column({ name: "duration_ms", type: "integer", default: 0 })
  durationMs!: number;

  /** 创建时间，存储为 epoch ms integer（毫秒精度，供 MoreThan 比较用）。 */
  @Column({
    name: "created_at",
    type: "integer",
    default: () => Date.now().toString(),
    transformer: epochMsTransformer,
  })
  createdAt!: Date;
}
