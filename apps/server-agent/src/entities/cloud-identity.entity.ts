import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * 云端身份的本地镜像（单机单行，id 固定 'default'）。
 * 持久化云端 token，供 server-agent 后台调云端（方案 A）。
 */
@Entity("cloud_identity")
export class CloudIdentity {
  @PrimaryColumn({ type: "text" })
  id!: string;

  @Column({ name: "cloud_user_id", type: "text" })
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

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
