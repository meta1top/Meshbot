import { SnowflakeBaseEntity } from "@meshbot/common";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  UpdateDateColumn,
} from "typeorm";

/** 技能市场包(元数据)。内容在 skill_version 指向 minio。 */
@Entity("skill_package")
@Index("idx_skill_package_slug", ["slug"], { unique: true })
export class SkillPackage extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 64 }) slug!: string;
  @Column({ type: "varchar", length: 128 }) displayName!: string;
  @Column({ type: "text" }) description!: string;
  @Column({ type: "varchar", length: 20 }) authorUserId!: string;
  @Column({ type: "varchar", length: 32 }) latestVersion!: string;
  @Column({ type: "boolean", default: true }) public!: boolean;
  @Column({ type: "int", default: 0 }) downloads!: number;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
