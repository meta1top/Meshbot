import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 网盘文件公开分享短链 */
@Entity("cloud_share_link")
export class CloudShareLink extends SnowflakeBaseEntity {
  /** 公开短码（url-safe，唯一） */
  @Index({ unique: true })
  @Column({ type: "varchar", length: 32 })
  token!: string;

  /** 指向 cloud_node（逻辑外键，仅 type=file） */
  @Column({ type: "varchar", length: 20 })
  nodeId!: string;

  @Column({ type: "varchar", length: 20 })
  orgId!: string;

  @Column({ type: "varchar", length: 20 })
  createdByUserId!: string;

  /** bcrypt 哈希；null=无密码 */
  @Column({ type: "varchar", length: 255, nullable: true })
  passwordHash!: string | null;

  /** null=永久 */
  @Column({ type: "timestamptz", nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  /** 软删；null=有效 */
  @Column({ type: "timestamptz", nullable: true })
  revokedAt!: Date | null;
}
