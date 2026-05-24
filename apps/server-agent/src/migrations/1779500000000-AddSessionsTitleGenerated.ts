import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * sessions 表加 title_generated 标记位。值义：title 是 LLM 生成或用户改过。
 * 用 INTEGER 0/1 存储（SQLite 没原生 boolean，TypeORM 用 INTEGER 映射）。
 */
export class AddSessionsTitleGenerated1779500000000
  implements MigrationInterface
{
  name = "AddSessionsTitleGenerated1779500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "title_generated" INTEGER NOT NULL DEFAULT 0`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 DROP COLUMN；保留列即可（参考 AddSessionsPinnedAt 的 down 注释）
  }
}
