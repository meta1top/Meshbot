import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * server-agent 首批 SQLite schema —— 替代 Phase 1/2 的 `synchronize: true`。
 *
 * 设计要点：
 * - `IF NOT EXISTS` 保证幂等（重跑安全 / 与既有 db 兼容）
 * - SQLite 无 varchar(N)，统一 TEXT；UUID 也是 TEXT
 * - `DATETIME DEFAULT CURRENT_TIMESTAMP` 替代 timestamptz
 * - 三张表：users / settings / model_configs
 * - DDL 与 Entity 定义对齐（`src/entities/*.entity.ts`），后续改动通过新增迁移
 *
 * 部署提示：开发者本地若已有 `synchronize:true` 生成的 db，删 `~/.meshbot/agent.db`
 * 重建即可（迁移 IF NOT EXISTS 兼容，但旧 db 没有 typeorm migrations 表）。
 */
export class InitialSchemaSqlite1778900000000 implements MigrationInterface {
  name = "InitialSchemaSqlite1778900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id"            TEXT PRIMARY KEY NOT NULL,
        "username"      TEXT NOT NULL,
        "password_hash" TEXT NOT NULL,
        "created_at"    DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_username" ON "users" ("username")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "settings" (
        "key"   TEXT PRIMARY KEY NOT NULL,
        "value" TEXT NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "model_configs" (
        "id"            TEXT PRIMARY KEY NOT NULL,
        "provider_type" TEXT NOT NULL,
        "name"          TEXT NOT NULL,
        "model"         TEXT NOT NULL,
        "api_key"       TEXT NOT NULL,
        "base_url"      TEXT NOT NULL DEFAULT '',
        "enabled"       INTEGER NOT NULL DEFAULT 1,
        "created_at"    DATETIME NOT NULL DEFAULT (datetime('now')),
        "updated_at"    DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "model_configs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "settings"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_username"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
