import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * cloud_identity 表加 device_token 列（可空）；model_configs 表加 source 列
 * （默认值 'local'，存量行自动回填 'local'）
 */
export class DeviceTokenAndModelSource1780800000000
  implements MigrationInterface
{
  name = "DeviceTokenAndModelSource1780800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cloud_identity" ADD COLUMN "device_token" TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE "model_configs" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'local'`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 DROP COLUMN;保留列(与既有迁移一致)
  }
}
