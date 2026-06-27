import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 删除「IM 伴生 Agent」功能的 schema 与数据：
 * 删唯一索引 → 清 kind='im' 伴生会话及其关联（session_messages/pending_messages/llm_calls）
 * → 删伴生列（agent_enabled / im_conv_type / im_conversation_id）。
 * 与删除伴生功能代码（im-agent.* + Session 伴生字段）配套。SQLite 3.35+ 支持 DROP COLUMN。
 */
export class DropSessionImCompanionFields1780600000000
  implements MigrationInterface
{
  name = "DropSessionImCompanionFields1780600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_sessions_im_companion"`);

    for (const t of ["session_messages", "pending_messages", "llm_calls"]) {
      await queryRunner.query(
        `DELETE FROM "${t}" WHERE "session_id" IN (SELECT "id" FROM "sessions" WHERE "kind" = 'im')`,
      );
    }
    await queryRunner.query(`DELETE FROM "sessions" WHERE "kind" = 'im'`);

    for (const c of ["agent_enabled", "im_conv_type", "im_conversation_id"]) {
      await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "${c}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "im_conversation_id" TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "im_conv_type" VARCHAR`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "agent_enabled" BOOLEAN NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sessions_im_companion" ON "sessions" ("cloud_user_id", "im_conversation_id") WHERE "kind" = 'im'`,
    );
  }
}
