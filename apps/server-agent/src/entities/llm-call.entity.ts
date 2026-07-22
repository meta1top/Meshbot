import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity } from "typeorm";

/**
 * 一次 LLM 调用的观测记录。
 * 每次 supervisor 节点跑完 model.stream 落一行；用于会话累计 token 与单条消息 token 明细。
 */
@Entity("llm_calls")
export class LlmCall extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ name: "session_id" })
  sessionId!: string;

  @Column({ name: "message_id" })
  messageId!: string;

  @Column({ name: "provider_type", type: "varchar" })
  providerType!: string;

  @Column({ type: "varchar" })
  model!: string;

  /** 调用时的模型配置显示名快照（云网关行 model 列是配置 id，改名/删除后靠它回显）。 */
  @Column({ name: "model_name", type: "varchar", nullable: true })
  modelName!: string | null;

  /**
   * 旁路调用的用途标记。NULL = 普通对话轮次（绝大多数行）。
   *
   * 目前唯一取值 "compaction"：上下文压缩的 summarize 调用。它必须与普通轮次
   * 区分开——`getLastBySession` 供压缩 pre-check 判阈值用，而 summarize 要把
   * 整段待压缩历史喂给模型、input_tokens 天然接近满窗口。
   *
   * 若不排除，压缩行会滞留为「最新一行」，造成**闩锁式误触发**：此后每次 run
   * 都白跑一次 snapshot，并在历史重新长到可压时提前压一次（浪费一次 summarize
   * 且过早丢上下文），直到落下一条普通轮次行才自愈。不是无限循环——压缩完
   * checkpointer 已小，再次 compact 会因 findSplitIndex 返 0 而空转返回。
   *
   * 注意语义不对称：**触发判断排除它，用量统计包含它**——token 是真花了的。
   */
  @Column({ name: "purpose", type: "varchar", nullable: true })
  purpose!: string | null;

  @Column({ name: "input_tokens", type: "integer", default: 0 })
  inputTokens!: number;

  @Column({ name: "output_tokens", type: "integer", default: 0 })
  outputTokens!: number;

  @Column({ name: "total_tokens", type: "integer", default: 0 })
  totalTokens!: number;

  @Column({ name: "cache_read_tokens", type: "integer", default: 0 })
  cacheReadTokens!: number;

  @Column({ name: "cache_creation_tokens", type: "integer", default: 0 })
  cacheCreationTokens!: number;

  @Column({ name: "reasoning_tokens", type: "integer", default: 0 })
  reasoningTokens!: number;

  @Column({ name: "duration_ms", type: "integer", default: 0 })
  durationMs!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
