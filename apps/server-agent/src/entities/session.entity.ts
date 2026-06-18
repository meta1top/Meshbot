import { SnowflakeBaseEntity } from "@meshbot/common";
import type { SessionStatus } from "@meshbot/types-agent";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  UpdateDateColumn,
} from "typeorm";

/** 会话表。id 同时作为 LangGraph thread_id 与 socket.io room id。 */
@Entity("sessions")
@Index("uq_sessions_im_companion", ["cloudUserId", "imConversationId"], {
  unique: true,
  where: "kind = 'im'",
})
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
  kind!: "user" | "im";

  @Column({ name: "im_conversation_id", type: "text", nullable: true })
  imConversationId!: string | null;

  @Column({ name: "im_conv_type", type: "varchar", nullable: true })
  imConvType!: "channel" | "dm" | null;

  @Column({ name: "agent_enabled", type: "boolean", default: true })
  agentEnabled!: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
