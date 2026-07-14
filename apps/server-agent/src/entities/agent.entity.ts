import { SnowflakeBaseEntity } from "@meshbot/common";
import type { AgentVisibility } from "@meshbot/types-agent";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

/**
 * Agent 表 —— 一个设备（账号）下可有多个 Agent，各自独立的人格/技能/MCP/记忆/工作区。
 * 物理内容落在 accounts/<cloudUserId>/agents/<id>/ 下，本表只存元数据。
 */
@Entity("agents")
export class Agent extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ type: "text" })
  name!: string;

  /** `emoji|背景色` 两段式，如 `🛠️|#3b82f6`。 */
  @Column({ type: "text" })
  avatar!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  /** 人格正文。每轮以 system:persona 稳定 id 注入，可随时改、立即对老会话生效。 */
  @Column({ name: "system_prompt", type: "text", default: "" })
  systemPrompt!: string;

  /** 该 Agent 的默认模型；会话级 modelConfigId 优先于它。 */
  @Column({ name: "default_model_config_id", type: "text", nullable: true })
  defaultModelConfigId!: string | null;

  /** 「允许远程」开关。本期只建列不消费，云端注册在计划二。 */
  @Column({ name: "remote_enabled", type: "boolean", default: false })
  remoteEnabled!: boolean;

  /** 远程可见性。本期恒 private，org 为组织共享预留。 */
  @Column({ type: "text", default: "private" })
  visibility!: AgentVisibility;

  @Column({ name: "sort_order", type: "integer", default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
