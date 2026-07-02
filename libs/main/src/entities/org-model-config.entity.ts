import { SnowflakeBaseEntity } from "@meshbot/common";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  UpdateDateColumn,
} from "typeorm";

/** 组织级模型配置(api_key 应用层加密存 apiKeyEnc) */
@Entity("org_model_config")
@Index("ix_org_model_config_org", ["orgId"])
export class OrgModelConfig extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) orgId!: string;
  @Column({ type: "varchar", length: 64 }) name!: string;
  @Column({ type: "varchar", length: 32 }) providerType!: string;
  @Column({ type: "varchar", length: 128 }) model!: string;
  @Column({ type: "text" }) apiKeyEnc!: string;
  @Column({ type: "varchar", length: 255, default: "" }) baseUrl!: string;
  @Column({ type: "int", default: 128_000 }) contextWindow!: number;
  @Column({ type: "boolean", default: true }) enabled!: boolean;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
