import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 用户↔组织 多对多成员关系。唯一索引 (org_id, user_id)。 */
@Entity("membership")
@Index("idx_membership_org_user", ["orgId", "userId"], { unique: true })
@Index("idx_membership_user", ["userId"])
export class Membership extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  orgId!: string;

  @Column({ type: "varchar", length: 20 })
  userId!: string;

  @Column({ type: "varchar", length: 16 })
  role!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
