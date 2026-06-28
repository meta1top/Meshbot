import { SnowflakeBaseEntity } from "@meshbot/common";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  UpdateDateColumn,
} from "typeorm";

/** 网盘节点（文件或文件夹统一表）。parent_id 自引用成目录树；asset_key 指向 Minio。 */
@Entity("cloud_node")
@Index("idx_cloud_node_parent", ["parentId"])
@Index("idx_cloud_node_org", ["orgId"])
export class CloudNode extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) orgId!: string;
  @Column({ type: "varchar", length: 20 }) ownerUserId!: string;
  @Column({ type: "varchar", length: 20, nullable: true }) parentId!:
    | string
    | null;
  @Column({ type: "varchar", length: 8 }) type!: "file" | "folder";
  @Column({ type: "varchar", length: 256 }) name!: string;
  @Column({ type: "varchar", length: 256, nullable: true }) assetKey!:
    | string
    | null;
  @Column({ type: "bigint", default: 0 }) sizeBytes!: number;
  @Column({ type: "varchar", length: 128, nullable: true }) mime!:
    | string
    | null;
  @Column({ type: "varchar", length: 64, nullable: true }) checksum!:
    | string
    | null;
  @Column({ type: "varchar", length: 12, default: "ready" }) status!:
    | "uploading"
    | "ready";
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
