import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 读时合并改造（D2）：一次性清掉存量 source='cloud' 缓存行。
 * 云端模型配置改由 CloudModelConfigProxyService 读时实时代理、不落本地，
 * sqlite 之后只保留用户本地维护的 source='local' 行。
 * 幂等（无 cloud 行时 DELETE 影响 0 行）；SQLite 无法「撤销删除」，down 留空。
 */
export class DropCloudModelConfigRows1781400000000
  implements MigrationInterface
{
  name = "DropCloudModelConfigRows1781400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "model_configs" WHERE "source" = 'cloud'`,
    );
  }

  public async down(): Promise<void> {
    // 数据删除不可逆（云端行本就无需回填，实时代理即可重建视图），down 留空。
  }
}
