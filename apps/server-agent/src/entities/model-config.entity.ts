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

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
