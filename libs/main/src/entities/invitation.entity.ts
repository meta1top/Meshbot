import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 组织邀请。token 即邮件邀请码。 */
@Entity("invitation")
@Index("idx_invitation_token", ["token"], { unique: true })
@Index("idx_invitation_org_email_pending", ["orgId", "email"], {
  unique: true,
  where: "status = 'pending'",
})
export class Invitation extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 })
  orgId!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 64 })
  token!: string;

  @Column({ type: "varchar", length: 16, default: "pending" })
  status!: string;

  @Column({ type: "varchar", length: 20 })
  invitedBy!: string;

  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  @Column({ type: "varchar", length: 20, nullable: true })
  acceptedBy!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  acceptedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
