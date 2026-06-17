import type { MigrationInterface, QueryRunner } from "typeorm";

/** sessions 伴生会话唯一约束：每账号每 IM 会话至多一条 kind='im' 伴生会话（并发首建竞态兜底）。SQLite。 */
export class AddSessionImCompanionUniqueIndex1780400000000
  implements MigrationInterface
{
  name = "AddSessionImCompanionUniqueIndex1780400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "sessions" WHERE "kind" = 'im' AND "rowid" NOT IN (
         SELECT MIN("rowid") FROM "sessions" WHERE "kind" = 'im'
         GROUP BY "cloud_user_id", "im_conversation_id"
       )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_sessions_im_companion" ON "sessions" ("cloud_user_id", "im_conversation_id") WHERE "kind" = 'im'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_sessions_im_companion"`);
  }
}
