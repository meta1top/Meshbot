import type { MigrationInterface, QueryRunner } from "typeorm";

export class ImAgentSession1780900000000 implements MigrationInterface {
  name = "ImAgentSession1780900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "im_agent_session" (
        "id" varchar(20) PRIMARY KEY NOT NULL,
        "conversation_id" TEXT NOT NULL,
        "session_id" TEXT NOT NULL,
        "cloud_user_id" TEXT NOT NULL,
        "last_processed_message_id" TEXT,
        "created_at" datetime NOT NULL DEFAULT (datetime('now'))
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_im_agent_session_conv" ON "im_agent_session" ("conversation_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_im_agent_session_cloud_user_id" ON "im_agent_session" ("cloud_user_id")`,
    );
  }

  public async down(): Promise<void> {
    // 保留表，回滚由重建库处理
  }
}
