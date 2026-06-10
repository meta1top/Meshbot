import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/** 组织邀请。token 即邮件邀请码。 */
@Entity("invitation")
@Index("idx_invitation_token", ["token"], { unique: true })
@Index("idx_invitation_org_email_pending", ["orgId", "email"], {
  unique: true,
  where: "status = 'pending'",
})
export class Invitation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  orgId!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 64 })
  token!: string;

  /** "pending" | "accepted" | "revoked" | "expired"。 */
  @Column({ type: "varchar", length: 16, default: "pending" })
  status!: string;

  @Column({ type: "uuid" })
  invitedBy!: string;

  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  @Column({ type: "uuid", nullable: true })
  acceptedBy!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  acceptedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
