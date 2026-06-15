import type { MigrationInterface, QueryRunner } from "typeorm";

/** cloud_identity 单行（id='default'）→ 多行（PK=cloud_user_id）+ logged_in。旧单行无法可靠映射账号，直接重建（D7 从空开始）。 */
export class CloudIdentityMultiRow1780200000000 implements MigrationInterface {
  name = "CloudIdentityMultiRow1780200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cloud_identity"`);
    await queryRunner.query(`
      CREATE TABLE "cloud_identity" (
        "cloud_user_id"          TEXT PRIMARY KEY NOT NULL,
        "email"                  TEXT NOT NULL,
        "display_name"           TEXT NOT NULL,
        "org_id"                 TEXT,
        "org_name"               TEXT,
        "role"                   TEXT,
        "cloud_token"            TEXT NOT NULL,
        "cloud_token_expires_at" TEXT,
        "logged_in"              INTEGER NOT NULL DEFAULT 0,
        "created_at"             DATETIME NOT NULL DEFAULT (datetime('now')),
        "updated_at"             DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_cloud_identity_logged_in" ON "cloud_identity" ("logged_in")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cloud_identity"`);
    await queryRunner.query(`
      CREATE TABLE "cloud_identity" (
        "id" TEXT PRIMARY KEY NOT NULL, "cloud_user_id" TEXT NOT NULL, "email" TEXT NOT NULL,
        "display_name" TEXT NOT NULL, "org_id" TEXT, "org_name" TEXT, "role" TEXT,
        "cloud_token" TEXT NOT NULL, "cloud_token_expires_at" TEXT,
        "created_at" DATETIME NOT NULL DEFAULT (datetime('now')), "updated_at" DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }
}
