import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * cron_jobs 表 —— 计划任务记录（cron / once 两种 kind）。
 *
 * - IF NOT EXISTS 保证幂等
 * - 列名 snake_case，与 `src/entities/cron-job.entity.ts` 对齐
 * - boolean 用 INTEGER（沿用 model_configs.enabled 约定）；可空时间列用 DATETIME NULL
 * - 索引 (session_id) 加速 listBySession / deleteBySession / findOwnedBy
 */
export class CronJobsTable1779800000000 implements MigrationInterface {
  name = "CronJobsTable1779800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cron_jobs" (
        "id"            TEXT PRIMARY KEY NOT NULL,
        "session_id"    TEXT NOT NULL,
        "kind"          TEXT NOT NULL,
        "cron_expr"     TEXT NULL,
        "timezone"      TEXT NULL,
        "run_at"        DATETIME NULL,
        "prompt"        TEXT NOT NULL,
        "title"         TEXT NOT NULL,
        "enabled"       INTEGER NOT NULL DEFAULT 1,
        "last_fired_at" DATETIME NULL,
        "next_fire_at"  DATETIME NULL,
        "created_at"    DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_cron_jobs_session" ON "cron_jobs" ("session_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cron_jobs_session"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cron_jobs"`);
  }
}
