import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * model_configs 加 context_window 列。
 *
 * 新行由 service 在 create / update 时按 MODEL_SPECS 解析后写入；
 * 旧行用一次性 CASE backfill。spec 表数值的"快照"应嵌在本迁移里，
 * 避免后续 spec 升级追溯影响历史行（A 方案：配置时快照语义）。
 */
export class AddModelConfigContextWindow1779600000000
  implements MigrationInterface
{
  name = "AddModelConfigContextWindow1779600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "model_configs" ADD COLUMN "context_window" INTEGER NOT NULL DEFAULT 128000`,
    );

    // 一次性 backfill 已有行；与 libs/types-agent/src/ai/model-specs.ts 的内置值保持一致
    await queryRunner.query(`
      UPDATE "model_configs" SET "context_window" = CASE "model"
        WHEN 'gpt-4o'                     THEN 128000
        WHEN 'gpt-4o-mini'                THEN 128000
        WHEN 'gpt-4-turbo'                THEN 128000
        WHEN 'gpt-4.1'                    THEN 1000000
        WHEN 'claude-opus-4-7'            THEN 200000
        WHEN 'claude-sonnet-4-6'          THEN 200000
        WHEN 'claude-haiku-4-5'           THEN 200000
        WHEN 'claude-3-5-sonnet'          THEN 200000
        WHEN 'claude-3-5-sonnet-20241022' THEN 200000
        WHEN 'claude-3-opus'              THEN 200000
        WHEN 'claude-3-haiku'             THEN 200000
        WHEN 'gemini-2.5-pro'             THEN 2000000
        WHEN 'gemini-2.5-flash'           THEN 1000000
        WHEN 'gemini-1.5-pro'             THEN 2000000
        WHEN 'gemini-1.5-flash'           THEN 1000000
        WHEN 'gemini-2.0-flash'           THEN 1000000
        WHEN 'deepseek-v4-pro'            THEN 1000000
        WHEN 'deepseek-chat'              THEN 64000
        WHEN 'deepseek-reasoner'          THEN 64000
        ELSE 128000
      END
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 DROP COLUMN；保留列即可（参考 AddSessionsPinnedAt 的 down 注释）
  }
}
