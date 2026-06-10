import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/** 用户↔组织 多对多成员关系。唯一索引 (org_id, user_id)。 */
@Entity("membership")
@Index("idx_membership_org_user", ["orgId", "userId"], { unique: true })
@Index("idx_membership_user", ["userId"])
export class Membership {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  orgId!: string;

  @Column({ type: "uuid" })
  userId!: string;

  /** "owner" | "member"。 */
  @Column({ type: "varchar", length: 16 })
  role!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
