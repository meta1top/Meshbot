import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 所有表主键从 UUID/复合键改为雪花 VARCHAR(20)。
 * session_messages 新增 langgraph_id 列（存原 LangGraph message UUID）。
 * cloud_identity 从 cloudUserId PK 改为代理雪花 PK + cloudUserId UNIQUE。
 * settings 从复合 PK 改为代理雪花 PK + (cloudUserId, key) UNIQUE。
 * 数据可清空：up/down 均 DROP+CREATE，无 backfill。
 */
export class SnowflakePrimaryKeys1780500000000 implements MigrationInterface {
  name = "SnowflakePrimaryKeys1780500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- 1. DROP（子表先删，无 FK 约束故顺序只影响可读性）
    for (const t of [
      "session_messages",
      "llm_calls",
      "pending_messages",
      "cron_jobs",
      "sessions",
      "model_configs",
      "cloud_identity",
      "settings",
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${t}"`);
    }

    // ---- 2. CREATE
    await queryRunner.query(`
      CREATE TABLE "sessions" (
        "id"                  VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id"       TEXT,
        "title"               TEXT         NOT NULL,
        "status"              VARCHAR      NOT NULL DEFAULT 'idle',
        "pinned_at"           DATETIME,
        "title_generated"     BOOLEAN      NOT NULL DEFAULT 0,
        "kind"                VARCHAR      NOT NULL DEFAULT 'user',
        "im_conversation_id"  TEXT,
        "im_conv_type"        VARCHAR,
        "agent_enabled"       BOOLEAN      NOT NULL DEFAULT 1,
        "created_at"          DATETIME     NOT NULL DEFAULT (datetime('now')),
        "updated_at"          DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_sessions_cloud_user_id" ON "sessions" ("cloud_user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sessions_im_companion" ON "sessions" ("cloud_user_id", "im_conversation_id") WHERE "kind" = 'im'`,
    );

    await queryRunner.query(`
      CREATE TABLE "session_messages" (
        "id"           VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT        NOT NULL,
        "seq"          INTEGER      NOT NULL DEFAULT 0,
        "session_id"   VARCHAR      NOT NULL,
        "langgraph_id" VARCHAR,
        "role"         VARCHAR      NOT NULL,
        "content"      TEXT         NOT NULL,
        "reasoning"    TEXT,
        "tool_calls"   TEXT,
        "tool_call_id" VARCHAR,
        "metadata"     TEXT,
        "created_at"   DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_session_messages_session_created_id" ON "session_messages" ("session_id", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_session_messages_session_seq" ON "session_messages" ("session_id", "seq")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_session_messages_cloud_user_id" ON "session_messages" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "llm_calls" (
        "id"                    VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id"         TEXT,
        "session_id"            VARCHAR      NOT NULL,
        "message_id"            VARCHAR      NOT NULL,
        "provider_type"         VARCHAR      NOT NULL,
        "model"                 VARCHAR      NOT NULL,
        "input_tokens"          INTEGER      NOT NULL DEFAULT 0,
        "output_tokens"         INTEGER      NOT NULL DEFAULT 0,
        "total_tokens"          INTEGER      NOT NULL DEFAULT 0,
        "cache_read_tokens"     INTEGER      NOT NULL DEFAULT 0,
        "cache_creation_tokens" INTEGER      NOT NULL DEFAULT 0,
        "reasoning_tokens"      INTEGER      NOT NULL DEFAULT 0,
        "duration_ms"           INTEGER      NOT NULL DEFAULT 0,
        "created_at"            DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_llm_calls_cloud_user_id" ON "llm_calls" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "model_configs" (
        "id"             VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id"  TEXT,
        "provider_type"  VARCHAR      NOT NULL,
        "name"           VARCHAR      NOT NULL,
        "model"          VARCHAR      NOT NULL,
        "api_key"        VARCHAR      NOT NULL,
        "base_url"       VARCHAR      NOT NULL DEFAULT '',
        "enabled"        BOOLEAN      NOT NULL DEFAULT 1,
        "context_window" INTEGER      NOT NULL DEFAULT 128000,
        "created_at"     DATETIME     NOT NULL DEFAULT (datetime('now')),
        "updated_at"     DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_model_configs_cloud_user_id" ON "model_configs" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "pending_messages" (
        "id"           VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT,
        "session_id"   VARCHAR      NOT NULL,
        "content"      TEXT         NOT NULL,
        "status"       VARCHAR      NOT NULL DEFAULT 'pending',
        "created_at"   DATETIME     NOT NULL DEFAULT (datetime('now')),
        "processed_at" DATETIME
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_pending_messages_cloud_user_id" ON "pending_messages" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "cron_jobs" (
        "id"           VARCHAR(20)   PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT         NOT NULL,
        "session_id"   VARCHAR       NOT NULL,
        "kind"         VARCHAR       NOT NULL,
        "cron_expr"    VARCHAR,
        "timezone"     VARCHAR,
        "run_at"       DATETIME,
        "prompt"       TEXT          NOT NULL,
        "title"        VARCHAR(200)  NOT NULL,
        "enabled"      BOOLEAN       NOT NULL DEFAULT 1,
        "last_fired_at" DATETIME,
        "next_fire_at"  DATETIME,
        "created_at"   DATETIME      NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_cron_jobs_cloud_user_id" ON "cron_jobs" ("cloud_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "cloud_identity" (
        "id"                    VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id"         TEXT         NOT NULL UNIQUE,
        "email"                 TEXT         NOT NULL,
        "display_name"          TEXT         NOT NULL,
        "org_id"                TEXT,
        "org_name"              TEXT,
        "role"                  TEXT,
        "cloud_token"           TEXT         NOT NULL,
        "cloud_token_expires_at" TEXT,
        "logged_in"             BOOLEAN      NOT NULL DEFAULT 0,
        "created_at"            DATETIME     NOT NULL DEFAULT (datetime('now')),
        "updated_at"            DATETIME     NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "settings" (
        "id"           VARCHAR(20)  PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT        NOT NULL,
        "key"          TEXT         NOT NULL,
        "value"        TEXT         NOT NULL,
        UNIQUE ("cloud_user_id", "key")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const t of [
      "session_messages",
      "llm_calls",
      "pending_messages",
      "cron_jobs",
      "sessions",
      "model_configs",
      "cloud_identity",
      "settings",
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${t}"`);
    }

    // 恢复旧 UUID schema（数据丢失可接受）
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "title" TEXT NOT NULL, "status" VARCHAR NOT NULL DEFAULT 'idle', "pinned_at" DATETIME, "title_generated" BOOLEAN NOT NULL DEFAULT 0, "kind" VARCHAR NOT NULL DEFAULT 'user', "im_conversation_id" TEXT, "im_conv_type" VARCHAR, "agent_enabled" BOOLEAN NOT NULL DEFAULT 1, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')), "updated_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "session_messages" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT NOT NULL, "seq" INTEGER NOT NULL DEFAULT 0, "session_id" VARCHAR NOT NULL, "role" VARCHAR NOT NULL, "content" TEXT NOT NULL, "reasoning" TEXT, "tool_calls" TEXT, "tool_call_id" VARCHAR, "metadata" TEXT, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "llm_calls" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "session_id" VARCHAR NOT NULL, "message_id" VARCHAR NOT NULL, "provider_type" VARCHAR NOT NULL, "model" VARCHAR NOT NULL, "input_tokens" INTEGER NOT NULL DEFAULT 0, "output_tokens" INTEGER NOT NULL DEFAULT 0, "total_tokens" INTEGER NOT NULL DEFAULT 0, "cache_read_tokens" INTEGER NOT NULL DEFAULT 0, "cache_creation_tokens" INTEGER NOT NULL DEFAULT 0, "reasoning_tokens" INTEGER NOT NULL DEFAULT 0, "duration_ms" INTEGER NOT NULL DEFAULT 0, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "model_configs" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "provider_type" VARCHAR NOT NULL, "name" VARCHAR NOT NULL, "model" VARCHAR NOT NULL, "api_key" VARCHAR NOT NULL, "base_url" VARCHAR NOT NULL DEFAULT '', "enabled" BOOLEAN NOT NULL DEFAULT 1, "context_window" INTEGER NOT NULL DEFAULT 128000, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')), "updated_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "pending_messages" ("id" CHAR(36) PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "session_id" VARCHAR NOT NULL, "content" TEXT NOT NULL, "status" VARCHAR NOT NULL DEFAULT 'pending', "created_at" DATETIME NOT NULL DEFAULT (datetime('now')), "processed_at" DATETIME)`,
    );
    await queryRunner.query(
      `CREATE TABLE "cron_jobs" ("id" VARCHAR PRIMARY KEY NOT NULL, "cloud_user_id" TEXT NOT NULL, "session_id" VARCHAR NOT NULL, "kind" VARCHAR NOT NULL, "cron_expr" VARCHAR, "timezone" VARCHAR, "run_at" DATETIME, "prompt" TEXT NOT NULL, "title" VARCHAR(200) NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT 1, "last_fired_at" DATETIME, "next_fire_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "cloud_identity" ("cloud_user_id" TEXT PRIMARY KEY NOT NULL, "email" TEXT NOT NULL, "display_name" TEXT NOT NULL, "org_id" TEXT, "org_name" TEXT, "role" TEXT, "cloud_token" TEXT NOT NULL, "cloud_token_expires_at" TEXT, "logged_in" BOOLEAN NOT NULL DEFAULT 0, "created_at" DATETIME NOT NULL DEFAULT (datetime('now')), "updated_at" DATETIME NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "settings" ("cloud_user_id" TEXT NOT NULL, "key" TEXT NOT NULL, "value" TEXT NOT NULL, PRIMARY KEY ("cloud_user_id", "key"))`,
    );
  }
}
