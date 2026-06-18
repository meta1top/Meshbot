import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 会话成员关系。唯一索引 (conversation_id, user_id)。 */
@Entity("conversation_member")
@Index("idx_conversation_member_conv_user", ["conversationId", "userId"], {
  unique: true,
})
export class ConversationMember extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  conversationId!: string;

  @Column({ type: "varchar", length: 20 })
  userId!: string;

  @Column({ type: "timestamptz", nullable: true })
  lastReadAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  joinedAt!: Date;
}
