import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

export type DeviceAuthStatus = "pending" | "approved" | "consumed";

/** 设备授权请求中间态(TTL 10 分钟) */
@Entity("device_auth_request")
export class DeviceAuthRequest extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 16, default: "pending" })
  status!: DeviceAuthStatus;
  @Column({ type: "varchar", length: 128 }) deviceName!: string;
  @Column({ type: "varchar", length: 32, default: "" }) platform!: string;
  @Column({ type: "varchar", length: 64 }) codeChallenge!: string;
  @Column({ type: "varchar", length: 255, nullable: true }) redirectUri!:
    | string
    | null;
  @Column({ type: "varchar", length: 32, nullable: true }) userCode!:
    | string
    | null;
  @Column({ type: "varchar", length: 20, nullable: true }) userId!:
    | string
    | null;
  @Column({ type: "int", default: 0 }) attempts!: number;
  @Column({ type: "timestamptz" }) expiresAt!: Date;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
