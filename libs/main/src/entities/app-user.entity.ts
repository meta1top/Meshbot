import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * 云端用户。云端轨独立账号体系（与 server-agent 单机 User 不共享）。
 * 列名 snake_case 由 SnakeNamingStrategy 处理。
 */
@Entity("app_user")
@Index("idx_app_user_email", ["email"], { unique: true })
export class AppUser {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 255 })
  passwordHash!: string;

  @Column({ type: "varchar", length: 64 })
  displayName!: string;

  @Column({ type: "uuid", nullable: true })
  activeOrgId!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
