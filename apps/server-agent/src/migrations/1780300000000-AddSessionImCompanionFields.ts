import type { MigrationInterface, QueryRunner } from "typeorm";

/** sessions 表加伴生 Agent 字段（IM 会话伴生会话）。SQLite。 */
export class AddSessionImCompanionFields1780300000000
  implements MigrationInterface
{
  name = "AddSessionImCompanionFields1780300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "kind" varchar NOT NULL DEFAULT 'user'`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "im_conversation_id" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "im_conv_type" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "agent_enabled" boolean NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sessions_cloud_user_im_conv" ON "sessions" ("cloud_user_id", "im_conversation_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_sessions_cloud_user_im_conv"`,
    );
    for (const col of [
      "agent_enabled",
      "im_conv_type",
      "im_conversation_id",
      "kind",
    ]) {
      await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "${col}"`);
    }
  }
}
