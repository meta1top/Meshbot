import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 会话消息。索引 (conversation_id, created_at) 支持按时间分页查询。 */
@Entity("message")
@Index("idx_message_conv_created_at", ["conversationId", "createdAt"])
export class Message extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  conversationId!: string;

  @Column({ type: "varchar", length: 20 })
  senderId!: string;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "varchar", length: 8, default: "user" })
  senderType!: "user" | "agent";

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
