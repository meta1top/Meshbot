import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * session_messages 表 —— 会话消息展示反面（append-only，永不删）。
 *
 * 与 LangGraph checkpointer 解耦：未来 LLM context 被 summarize 压缩时
 * 展示历史不受影响。
 *
 * - IF NOT EXISTS 保证幂等
 * - 复合索引 (session_id, created_at, id) 支撑 cursor 翻页：
 *   `WHERE session_id=? AND created_at < ? ORDER BY created_at DESC`
 * - 列名 snake_case；TEXT/DATETIME；reasoning / tool_calls / tool_call_id 可空
 */
export class SessionMessagesTable1779300000000 implements MigrationInterface {
  name = "SessionMessagesTable1779300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "session_messages" (
        "id"           TEXT PRIMARY KEY NOT NULL,
        "session_id"   TEXT NOT NULL,
        "role"         TEXT NOT NULL,
        "content"      TEXT NOT NULL,
        "reasoning"    TEXT,
        "tool_calls"   TEXT,
        "tool_call_id" TEXT,
        "created_at"   DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_session_messages_session_created" ON "session_messages" ("session_id", "created_at", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_session_messages_session_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "session_messages"`);
  }
}
