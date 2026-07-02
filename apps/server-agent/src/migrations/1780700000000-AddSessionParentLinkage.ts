import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * sessions 表加 parent_session_id / parent_tool_call_id —— 子 Agent 子会话
 * 关联父会话与那次 dispatch 工具调用。两列均可空（普通会话为 NULL）。
 */
export class AddSessionParentLinkage1780700000000
  implements MigrationInterface
{
  name = "AddSessionParentLinkage1780700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "parent_session_id" TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "parent_tool_call_id" TEXT`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sessions_parent" ON "sessions" ("parent_session_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sessions_parent"`);
    // SQLite 不支持 DROP COLUMN；本地轨保留列即可（与既有迁移一致）
  }
}
