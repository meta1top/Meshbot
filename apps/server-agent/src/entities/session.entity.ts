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

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
