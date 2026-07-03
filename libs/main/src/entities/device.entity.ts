import { SnowflakeBaseEntity } from "@meshbot/common";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  UpdateDateColumn,
} from "typeorm";

/** 已授权设备(device token 载体,token 只存哈希) */
@Entity("device")
@Index("uq_device_token_hash", ["tokenHash"], { unique: true })
@Index("ix_device_user", ["userId"])
export class Device extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) userId!: string;
  @Column({ type: "varchar", length: 20, nullable: true }) orgId!:
    | string
    | null;
  @Column({ type: "varchar", length: 128 }) name!: string;
  @Column({ type: "varchar", length: 32, default: "" }) platform!: string;
  @Column({ type: "varchar", length: 64 }) tokenHash!: string;
  @Column({ type: "timestamptz", nullable: true }) lastSeenAt!: Date | null;
  @Column({ type: "timestamptz", nullable: true }) revokedAt!: Date | null;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
