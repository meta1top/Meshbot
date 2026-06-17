import type { SessionStatus } from "@meshbot/types-agent";
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** 会话表。id 同时作为 LangGraph thread_id 与 socket.io room id。 */
@Entity("sessions")
export class Session {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column()
  title!: string;

  /** idle = 无 run 在跑；running = 有 run 在跑。 */
  @Column({ type: "varchar", default: "idle" })
  status!: SessionStatus;

  /**
   * 非 null = 已固定。值 = 固定时间，用于「最近固定的在上」排序，也作未来
   * drag-to-pin 重排的字段。不引入额外 boolean 字段：单字段同时承担状态 + 顺序，
   * 避免不一致。
   */
  @Column({ name: "pinned_at", type: "datetime", nullable: true })
  pinnedAt!: Date | null;

  /**
   * 是否「有过明确标题」：LLM 自动生成成功 或 用户手动改过。
   * 用一个字段同时挡住两件事：title 生成任务避免覆盖用户改名 + 未来「重生成
   * 标题」入口判断是否已生成。createSession 默认 false。
   */
  @Column({ name: "title_generated", default: false })
  titleGenerated!: boolean;

  /** 'user' = 用户主动会话（默认）；'im' = IM 会话的伴生 Agent 会话（隐藏）。 */
  @Column({ type: "varchar", default: "user" })
  kind!: "user" | "im";

  /** 伴生会话绑定的 IM conversationId；kind='user' 为 null。 */
  @Column({ name: "im_conversation_id", type: "text", nullable: true })
  imConversationId!: string | null;

  /** 伴生会话对应的 IM 会话类型，用于触发判定；kind='user' 为 null。 */
  @Column({ name: "im_conv_type", type: "varchar", nullable: true })
  imConvType!: "channel" | "dm" | null;

  /** 仅 kind='im' 有意义：该 IM 会话是否启用伴生 Agent，默认开。 */
  @Column({ name: "agent_enabled", type: "boolean", default: true })
  agentEnabled!: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
