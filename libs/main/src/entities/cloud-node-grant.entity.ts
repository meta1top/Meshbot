import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 网盘 ACL 授权。无 grant = 私有（仅 owner）。同一被授权方一条（唯一），重设覆盖 permission。 */
@Entity("cloud_node_grant")
@Index("idx_cloud_grant_node", ["nodeId"])
@Index("idx_cloud_grant_unique", ["nodeId", "granteeType", "granteeId"], {
  unique: true,
})
export class CloudNodeGrant extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) nodeId!: string;
  @Column({ type: "varchar", length: 8 }) granteeType!: "org" | "user";
  @Column({ type: "varchar", length: 20 }) granteeId!: string;
  @Column({ type: "varchar", length: 8 }) permission!: "viewer" | "editor";
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}
