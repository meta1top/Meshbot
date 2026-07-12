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
