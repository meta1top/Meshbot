import { Column, CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

/** 计划任务记录。本地 SQLite，逻辑外键无 DB 约束。 */
@Entity("cron_jobs")
export class CronJob {
  @PrimaryColumn() id!: string;

  @Column({ name: "session_id" }) sessionId!: string;

  @Column({ type: "varchar" }) kind!: "cron" | "once";

  @Column({ name: "cron_expr", type: "varchar", nullable: true })
  cronExpr!: string | null;

  @Column({ type: "varchar", nullable: true })
  timezone!: string | null;

  @Column({ name: "run_at", type: "datetime", nullable: true })
  runAt!: Date | null;

  @Column({ type: "text" }) prompt!: string;
  @Column({ type: "varchar", length: 200 }) title!: string;

  @Column({ type: "boolean", default: true }) enabled!: boolean;

  @Column({ name: "last_fired_at", type: "datetime", nullable: true })
  lastFiredAt!: Date | null;

  @Column({ name: "next_fire_at", type: "datetime", nullable: true })
  nextFireAt!: Date | null;

  @CreateDateColumn({ name: "created_at" }) createdAt!: Date;
}
