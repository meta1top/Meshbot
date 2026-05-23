import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * llm_calls 表 —— 每次 LLM 调用的 token 观测记录。
 *
 * - IF NOT EXISTS 保证幂等
 * - 索引 (session_id) 加速会话累计 SUM 与 history 接口的 listBySession
 * - 列名 snake_case；TEXT/INTEGER/DATETIME
 */
export class LlmCallTable1779200000000 implements MigrationInterface {
  name = "LlmCallTable1779200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_calls" (
        "id"                     TEXT PRIMARY KEY NOT NULL,
        "session_id"             TEXT NOT NULL,
        "message_id"             TEXT NOT NULL,
        "provider_type"          TEXT NOT NULL,
        "model"                  TEXT NOT NULL,
        "input_tokens"           INTEGER NOT NULL DEFAULT 0,
        "output_tokens"          INTEGER NOT NULL DEFAULT 0,
        "total_tokens"           INTEGER NOT NULL DEFAULT 0,
        "cache_read_tokens"      INTEGER NOT NULL DEFAULT 0,
        "cache_creation_tokens"  INTEGER NOT NULL DEFAULT 0,
        "reasoning_tokens"       INTEGER NOT NULL DEFAULT 0,
        "duration_ms"            INTEGER NOT NULL DEFAULT 0,
        "created_at"             DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_llm_calls_session" ON "llm_calls" ("session_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_calls_session"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_calls"`);
  }
}
