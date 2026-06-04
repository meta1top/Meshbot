import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * session_messages 加 seq 列 —— 会话内单调递增序号，唯一可靠排序键。
 *
 * 背景：旧排序键 createdAt 同毫秒碰撞后退化为随机 UUID 比较，批量 / 定时任务
 * 注入的消息刷新后时序错乱。seq 由 INSERT 原子子查询赋值，杜绝并发写碰撞。
 *
 * - 加列 NOT NULL DEFAULT 0
 * - backfill：按会话 (created_at, id) 升序赋 1-based 连续 seq（保持旧数据
 *   当前展示序；历史真实序信息已丢失，仅杜绝未来错乱）
 * - 复合索引 (session_id, seq) 支撑 ORDER BY seq 翻页
 */
export class AddSessionMessagesSeq1779900000000 implements MigrationInterface {
  name = "AddSessionMessagesSeq1779900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_messages" ADD COLUMN "seq" INTEGER NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`
      UPDATE "session_messages" SET "seq" = (
        SELECT COUNT(*) FROM "session_messages" m2
        WHERE m2."session_id" = "session_messages"."session_id"
          AND (m2."created_at" < "session_messages"."created_at"
            OR (m2."created_at" = "session_messages"."created_at"
                AND m2."id" <= "session_messages"."id"))
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_session_messages_session_seq" ON "session_messages" ("session_id", "seq")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_session_messages_session_seq"`,
    );
    // SQLite 不支持 DROP COLUMN；保留 seq 列即可（参考既有 AddSessionsPinnedAt 注释）
  }
}
