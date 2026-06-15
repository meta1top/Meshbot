import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

/** 云端身份镜像（v3 多行）：每个登录过的云端账号一行，主键 = cloudUserId。 */
@Entity("cloud_identity")
export class CloudIdentity {
  @PrimaryColumn({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ type: "text" })
  email!: string;

  @Column({ name: "display_name", type: "text" })
  displayName!: string;

  @Column({ name: "org_id", type: "text", nullable: true })
  orgId!: string | null;

  @Column({ name: "org_name", type: "text", nullable: true })
  orgName!: string | null;

  @Column({ type: "text", nullable: true })
  role!: string | null;

  @Column({ name: "cloud_token", type: "text" })
  cloudToken!: string;

  @Column({ name: "cloud_token_expires_at", type: "text", nullable: true })
  cloudTokenExpiresAt!: string | null;

  @Column({ name: "logged_in", type: "boolean", default: false })
  loggedIn!: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
