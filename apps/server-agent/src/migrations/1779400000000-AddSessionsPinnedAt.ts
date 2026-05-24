import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * sessions 表加 pinned_at 列 —— 单字段同时承担「是否固定」+「固定顺序」。
 * 索引覆盖 list 排序：CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END, pinned_at DESC, updated_at DESC。
 */
export class AddSessionsPinnedAt1779400000000 implements MigrationInterface {
  name = "AddSessionsPinnedAt1779400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "pinned_at" DATETIME`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sessions_pinned_updated" ON "sessions" ("pinned_at", "updated_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_sessions_pinned_updated"`,
    );
    // SQLite 不支持 DROP COLUMN；重建表代价大且本地轨数据为 dev，保留列即可
  }
}
