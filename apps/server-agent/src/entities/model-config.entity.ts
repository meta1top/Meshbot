import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("model_configs")
export class ModelConfig {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

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

  /**
   * 模型上下文窗口（token），配置入库时一次性解析固化（spec 后续变化不回填）。
   * 解析优先级：用户显式给 > MODEL_SPECS > FALLBACK_CONTEXT_WINDOW（128_000）。
   */
  @Column({ name: "context_window", type: "int", default: 128_000 })
  contextWindow!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
