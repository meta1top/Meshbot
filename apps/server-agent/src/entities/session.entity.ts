import { SnowflakeBaseEntity } from "@meshbot/common";
import type { SessionStatus } from "@meshbot/types-agent";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

/** 会话表。id 同时作为 LangGraph thread_id 与 socket.io room id。 */
@Entity("sessions")
export class Session extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column()
  title!: string;

  @Column({ type: "varchar", default: "idle" })
  status!: SessionStatus;

  @Column({ name: "pinned_at", type: "datetime", nullable: true })
  pinnedAt!: Date | null;

  @Column({ name: "title_generated", default: false })
  titleGenerated!: boolean;

  @Column({ type: "varchar", default: "user" })
  kind!: "user" | "quick" | "subagent";

  @Column({ name: "parent_session_id", type: "text", nullable: true })
  parentSessionId!: string | null;

  @Column({ name: "parent_tool_call_id", type: "text", nullable: true })
  parentToolCallId!: string | null;

  /** 「有待了结的后台子任务」标记：建后台子会话置 1，播报完成置 0；兼作重启恢复扫描键。 */
  @Column({ type: "integer", default: 0 })
  background!: number;

  /** per-run 模型覆盖：dispatch 解析成功的 ModelConfig id；非 subagent 会话恒 NULL。 */
  @Column({ name: "model_config_id", type: "text", nullable: true })
  modelConfigId!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
