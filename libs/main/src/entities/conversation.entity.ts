import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 会话（频道或 DM）。type='channel' 时 name 非空；type='dm' 时 dmKey 非空。 */
@Entity("conversation")
@Index("idx_conversation_org_type", ["orgId", "type"])
export class Conversation extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  orgId!: string;

  @Column({ type: "varchar", length: 16 })
  type!: string;

  @Column({ type: "varchar", length: 64, nullable: true })
  name!: string | null;

  @Column({ type: "varchar", length: 80, nullable: true })
  dmKey!: string | null;

  @Column({ type: "varchar", length: 20 })
  createdBy!: string;

  @Column({ type: "varchar", length: 16, default: "public" })
  visibility!: "public" | "private";

  @Column({ type: "varchar", length: 20, nullable: true })
  agentDeviceId!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
