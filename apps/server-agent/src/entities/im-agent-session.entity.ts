import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity } from "typeorm";

/** IM Agent 会话映射表：关联 Agent-DM 云端对话 (conversationId) 与本地 Agent 会话 (sessionId)，支持处理游标跟踪。 */
@Entity("im_agent_session")
export class ImAgentSession extends SnowflakeBaseEntity {
  /** 云端 IM 对话 ID （唯一）。 */
  @Column({ name: "conversation_id", type: "text" })
  conversationId!: string;

  /** 本地 Agent 会话 ID。 */
  @Column({ name: "session_id", type: "text" })
  sessionId!: string;

  /** 云端用户 ID（作用域过滤键）。 */
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  /** 最后处理的消息 ID（游标）。 */
  @Column({ name: "last_processed_message_id", type: "text", nullable: true })
  lastProcessedMessageId!: string | null;

  /** 创建时间。 */
  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
