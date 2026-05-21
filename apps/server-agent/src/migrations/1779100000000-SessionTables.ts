import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 会话相关两张表：sessions / pending_messages。
 *
 * - IF NOT EXISTS 保证幂等
 * - SQLite 统一 TEXT；UUID 也是 TEXT
 * - pending_messages.session_id 逻辑外键，无 DB 约束
 * - 按 session_id + status 建索引，加速 RunnerService 取 pending 消息
 */
export class SessionTables1779100000000 implements MigrationInterface {
  name = "SessionTables1779100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sessions" (
        "id"         TEXT PRIMARY KEY NOT NULL,
        "title"      TEXT NOT NULL,
        "status"     TEXT NOT NULL DEFAULT 'idle',
        "created_at" DATETIME NOT NULL DEFAULT (datetime('now')),
        "updated_at" DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pending_messages" (
        "id"           TEXT PRIMARY KEY NOT NULL,
        "session_id"   TEXT NOT NULL,
        "content"      TEXT NOT NULL,
        "status"       TEXT NOT NULL DEFAULT 'pending',
        "created_at"   DATETIME NOT NULL DEFAULT (datetime('now')),
        "processed_at" DATETIME
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_pending_messages_session_status" ON "pending_messages" ("session_id", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_pending_messages_session_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "pending_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sessions"`);
  }
}
