import { SnowflakeBaseEntity } from "@meshbot/common";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  UpdateDateColumn,
} from "typeorm";

/** 云端 Agent 注册表(设备侧 remote_enabled Agent 元数据镜像;软删对账)。 */
@Entity("agent")
@Index("ix_agent_device", ["deviceId"])
@Index("ix_agent_user", ["userId"])
@Index("uq_agent_device_local", ["deviceId", "localAgentId"], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class CloudAgent extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) deviceId!: string;
  @Column({ type: "varchar", length: 20 }) userId!: string;
  @Column({ type: "varchar", length: 20, nullable: true }) orgId!:
    | string
    | null;
  @Column({ type: "varchar", length: 20 }) localAgentId!: string;
  @Column({ type: "varchar", length: 128 }) name!: string;
  @Column({ type: "varchar", length: 64, default: "" }) avatar!: string;
  @Column({ type: "text", nullable: true }) description!: string | null;
  @Column({ type: "varchar", length: 16, default: "private" })
  visibility!: string;
  @Column({ type: "timestamptz", nullable: true }) lastSyncedAt!: Date | null;
  @Column({ type: "timestamptz", nullable: true }) deletedAt!: Date | null;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
