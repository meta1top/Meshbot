import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/** 会话（频道或 DM）。type='channel' 时 name 非空，dm_key 为 null；type='dm' 时相反。 */
@Entity("conversation")
@Index("idx_conversation_org_type", ["orgId", "type"])
export class Conversation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  orgId!: string;

  /** 'channel' | 'dm' */
  @Column({ type: "varchar", length: 16 })
  type!: string;

  /** 频道名；dm 为 null。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  name!: string | null;

  /** DM 去重键（如 sorted user ids）；channel 为 null。 */
  @Column({ type: "varchar", length: 80, nullable: true })
  dmKey!: string | null;

  @Column({ type: "uuid" })
  createdBy!: string;

  /** 'public'（组织级可见）| 'private'（仅成员可见）。dm 不参与判定。 */
  @Column({ type: "varchar", length: 16, default: "public" })
  visibility!: "public" | "private";

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
