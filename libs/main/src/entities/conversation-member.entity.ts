import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/** 会话成员关系。唯一索引 (conversation_id, user_id)。 */
@Entity("conversation_member")
@Index("idx_conversation_member_conv_user", ["conversationId", "userId"], {
  unique: true,
})
export class ConversationMember {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  conversationId!: string;

  @Column({ type: "uuid" })
  userId!: string;

  /** 用户最后已读时间戳，用于计算未读数。 */
  @Column({ type: "timestamptz", nullable: true })
  lastReadAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  joinedAt!: Date;
}
