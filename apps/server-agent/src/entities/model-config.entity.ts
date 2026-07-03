import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

@Entity("model_configs")
export class ModelConfig extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ name: "provider_type" })
  providerType!: string;

  @Column()
  name!: string;

  @Column()
  model!: string;

  @Column({ name: "api_key" })
  apiKey!: string;

  @Column({ name: "base_url", default: "" })
  baseUrl!: string;

  @Column({ default: true })
  enabled!: boolean;

  @Column({ name: "context_window", type: "int", default: 128_000 })
  contextWindow!: number;

  @Column({ type: "text", default: "local" })
  source!: "cloud" | "local";

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
