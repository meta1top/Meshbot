import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * server-main 首批 schema（Phase 3 框架基线）。只建 app_user 一张表作为
 * 注册 / 登录示范；真实业务等 meshbot 自己迭代后再叠加迁移。
 *
 * 设计要点：
 * - `IF NOT EXISTS` 保证幂等
 * - `pgcrypto` 提供 `gen_random_uuid()`
 * - 不写数据库 FK 约束（项目约定 logical FK）
 * - 列名 snake_case 由 `SnakeNamingStrategy` 处理
 * - 索引未用 CONCURRENTLY：runtime migrationsRun 会用事务包；后续高并发线上单独拆迁移 + transaction=false
 */
export class InitialSchema1778869010469 implements MigrationInterface {
  name = "InitialSchema1778869010469";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_user" (
        "id"            uuid          NOT NULL DEFAULT gen_random_uuid(),
        "email"         varchar(255)  NOT NULL,
        "password_hash" varchar(255)  NOT NULL,
        "display_name"  varchar(64)   NOT NULL,
        "created_at"    timestamptz   NOT NULL DEFAULT now(),
        "updated_at"    timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "pk_app_user" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_user_email" ON "app_user" ("email")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "app_user" CASCADE`);
  }
}
