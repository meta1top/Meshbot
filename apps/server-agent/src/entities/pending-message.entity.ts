import type { PendingMessageStatus } from "@meshbot/types-agent";
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity } from "typeorm";

/** 待处理用户消息表。按 session 排队，run 结束后整批取出处理。 */
@Entity("pending_messages")
export class PendingMessage extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ name: "session_id" })
  sessionId!: string;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: PendingMessageStatus;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @Column({ name: "processed_at", type: "datetime", nullable: true })
  processedAt!: Date | null;
}
