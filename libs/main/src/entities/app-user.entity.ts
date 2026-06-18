import { SnowflakeBaseEntity } from "@meshbot/common";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  UpdateDateColumn,
} from "typeorm";

/** 云端用户。云端轨独立账号体系（与 server-agent 单机用户不共享）。 */
@Entity("app_user")
@Index("idx_app_user_email", ["email"], { unique: true })
export class AppUser extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 255 })
  passwordHash!: string;

  @Column({ type: "varchar", length: 64 })
  displayName!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  activeOrgId!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
