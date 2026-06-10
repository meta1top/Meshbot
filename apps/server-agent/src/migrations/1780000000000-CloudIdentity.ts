import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 云端身份镜像表 + 退役本地 users 表。
 * Phase 1 去掉本地密码登录，身份真相源在云端；本地仅存镜像 + 云端 token。
 * 既有单机 users 行无云端对应物，直接 drop（用户升级后重新走云端登录）。
 */
export class CloudIdentity1780000000000 implements MigrationInterface {
  name = "CloudIdentity1780000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cloud_identity" (
        "id"                     TEXT PRIMARY KEY NOT NULL,
        "cloud_user_id"          TEXT NOT NULL,
        "email"                  TEXT NOT NULL,
        "display_name"           TEXT NOT NULL,
        "org_id"                 TEXT,
        "org_name"               TEXT,
        "role"                   TEXT,
        "cloud_token"            TEXT NOT NULL,
        "cloud_token_expires_at" TEXT,
        "created_at"             DATETIME NOT NULL DEFAULT (datetime('now')),
        "updated_at"             DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_username"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cloud_identity"`);
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
  }
}
