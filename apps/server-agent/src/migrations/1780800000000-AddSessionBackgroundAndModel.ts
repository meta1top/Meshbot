import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 2：后台派发支持。
 * - background：「有待了结的后台子任务」标记（建后台子会话置 1，播报完成置 0），
 *   兼作重启恢复扫描键。
 * - model_config_id：per-run 模型覆盖（dispatch 解析成功的 ModelConfig id）。
 * SQLite 限制：down 不删列（与既有迁移约定一致）。
 */
export class AddSessionBackgroundAndModel1780800000000
  implements MigrationInterface
{
  name = "AddSessionBackgroundAndModel1780800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "background" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "model_config_id" TEXT`,
    );
  }

  public async down(): Promise<void> {
    // SQLite 不支持 DROP COLUMN（旧版），保持列存在（幂等，与仓库既有迁移一致）
  }
}
