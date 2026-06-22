import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 技能某版本。asset_key 指向 minio 对象。 */
@Entity("skill_version")
@Index("idx_skill_version_pkg_ver", ["packageId", "version"], { unique: true })
export class SkillVersion extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) packageId!: string;
  @Column({ type: "varchar", length: 32 }) version!: string;
  @Column({ type: "varchar", length: 256 }) assetKey!: string;
  @Column({ type: "varchar", length: 64 }) checksum!: string;
  @Column({ type: "int" }) sizeBytes!: number;
  @Column({ type: "text" }) readme!: string;
  @Column({ type: "text", nullable: true }) changelog!: string | null;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}
