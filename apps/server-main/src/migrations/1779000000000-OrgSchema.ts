import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 组织域 schema：organization / membership / invitation 三张表，
 * 外加 app_user.active_org_id 列。logical FK，无数据库外键约束。
 */
export class OrgSchema1779000000000 implements MigrationInterface {
  name = "OrgSchema1779000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_user"
      ADD COLUMN IF NOT EXISTS "active_org_id" uuid
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "organization" (
        "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
        "name"       varchar(64)  NOT NULL,
        "owner_id"   uuid         NOT NULL,
        "created_at" timestamptz  NOT NULL DEFAULT now(),
        "updated_at" timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_organization" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "membership" (
        "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
        "org_id"     uuid         NOT NULL,
        "user_id"    uuid         NOT NULL,
        "role"       varchar(16)  NOT NULL,
        "created_at" timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_membership" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_membership_org_user" ON "membership" ("org_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_membership_user" ON "membership" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invitation" (
        "id"          uuid         NOT NULL DEFAULT gen_random_uuid(),
        "org_id"      uuid         NOT NULL,
        "email"       varchar(255) NOT NULL,
        "token"       varchar(64)  NOT NULL,
        "status"      varchar(16)  NOT NULL DEFAULT 'pending',
        "invited_by"  uuid         NOT NULL,
        "expires_at"  timestamptz  NOT NULL,
        "accepted_by" uuid,
        "accepted_at" timestamptz,
        "created_at"  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_invitation" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_token" ON "invitation" ("token")`,
    );
    // 同组织同邮箱仅允许一条 pending（防重复邀请）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_org_email_pending" ON "invitation" ("org_id", "email") WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "invitation" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "membership" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organization" CASCADE`);
    await queryRunner.query(
      `ALTER TABLE "app_user" DROP COLUMN IF EXISTS "active_org_id"`,
    );
  }
}
