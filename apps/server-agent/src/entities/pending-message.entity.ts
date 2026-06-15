import type { PendingMessageStatus } from "@meshbot/types-agent";
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

/** 待处理用户消息表。按 session 排队，run 结束后整批取出处理。 */
@Entity("pending_messages")
export class PendingMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  /** 逻辑外键，无 DB 约束。 */
  @Column({ name: "session_id" })
  sessionId!: string;

  @Column({ type: "text" })
  content!: string;

  /** pending=排队中；processing=处理中；processed=已完成；failed=处理失败可重试。 */
  @Column({ type: "varchar", default: "pending" })
  status!: PendingMessageStatus;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @Column({ name: "processed_at", type: "datetime", nullable: true })
  processedAt!: Date | null;
}
