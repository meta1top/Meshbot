import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 7 张账号隔离表加 cloud_user_id（v3 字段隔离）。
 * 旧单用户数据无 cloud_user_id（NULL）→ 被作用域过滤，符合 D7「从空开始」。
 * settings 主键改为复合 (cloud_user_id, key)：SQLite 无 ALTER PRIMARY KEY，需重建表。
 */
export class AddCloudUserIdToAccountTables1780100000000
  implements MigrationInterface
{
  name = "AddCloudUserIdToAccountTables1780100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      "sessions",
      "session_messages",
      "pending_messages",
      "llm_calls",
      "model_configs",
      "cron_jobs",
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN "cloud_user_id" TEXT`,
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "idx_${table}_cloud_user_id" ON "${table}" ("cloud_user_id")`,
      );
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "settings_new" (
        "cloud_user_id" TEXT NOT NULL,
        "key"           TEXT NOT NULL,
        "value"         TEXT NOT NULL,
        PRIMARY KEY ("cloud_user_id", "key")
      )
    `);
    await queryRunner.query(`DROP TABLE "settings"`);
    await queryRunner.query(`ALTER TABLE "settings_new" RENAME TO "settings"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      "sessions",
      "session_messages",
      "pending_messages",
      "llm_calls",
      "model_configs",
      "cron_jobs",
    ]) {
      await queryRunner.query(
        `DROP INDEX IF EXISTS "idx_${table}_cloud_user_id"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN "cloud_user_id"`,
      );
    }
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "settings_old" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL)
    `);
    await queryRunner.query(`DROP TABLE "settings"`);
    await queryRunner.query(`ALTER TABLE "settings_old" RENAME TO "settings"`);
  }
}
