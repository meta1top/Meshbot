-- =============================================================================
-- meshbot server-main 雪花主键迁移（所有表 UUID PK → VARCHAR(20) 雪花 ID）
--
-- 执行方式：DBA 手动执行（psql -f 202606181200-snowflake-primary-keys.sql）
-- 注意：此文件 DROP + CREATE，会清空所有数据。执行前确认无生产数据。
-- 执行后应用层由 SnowflakeBaseEntity @BeforeInsert 负责生成雪花 ID。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- DROP（子表先删，虽无 FK 约束，顺序保持可读）
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "message";
DROP TABLE IF EXISTS "conversation_member";
DROP TABLE IF EXISTS "conversation";
DROP TABLE IF EXISTS "invitation";
DROP TABLE IF EXISTS "membership";
DROP TABLE IF EXISTS "organization";
DROP TABLE IF EXISTS "app_user";

-- ---------------------------------------------------------------------------
-- app_user
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "app_user" (
  "id"            varchar(20)  NOT NULL,
  "email"         varchar(255) NOT NULL,
  "password_hash" varchar(255) NOT NULL,
  "display_name"  varchar(64)  NOT NULL,
  "active_org_id" varchar(20),
  "created_at"    timestamptz  NOT NULL DEFAULT now(),
  "updated_at"    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_app_user" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_user_email" ON "app_user" ("email");

-- ---------------------------------------------------------------------------
-- organization
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "organization" (
  "id"         varchar(20) NOT NULL,
  "name"       varchar(64) NOT NULL,
  "owner_id"   varchar(20) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_organization" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- membership
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "membership" (
  "id"         varchar(20) NOT NULL,
  "org_id"     varchar(20) NOT NULL,
  "user_id"    varchar(20) NOT NULL,
  "role"       varchar(16) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_membership" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_membership_org_user" ON "membership" ("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_membership_user" ON "membership" ("user_id");

-- ---------------------------------------------------------------------------
-- invitation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "invitation" (
  "id"          varchar(20)  NOT NULL,
  "org_id"      varchar(20)  NOT NULL,
  "email"       varchar(255) NOT NULL,
  "token"       varchar(64)  NOT NULL,
  "status"      varchar(16)  NOT NULL DEFAULT 'pending',
  "invited_by"  varchar(20)  NOT NULL,
  "expires_at"  timestamptz  NOT NULL,
  "accepted_by" varchar(20),
  "accepted_at" timestamptz,
  "created_at"  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_invitation" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_token" ON "invitation" ("token");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_org_email_pending"
  ON "invitation" ("org_id", "email") WHERE "status" = 'pending';

-- ---------------------------------------------------------------------------
-- conversation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "conversation" (
  "id"         varchar(20) NOT NULL,
  "org_id"     varchar(20) NOT NULL,
  "type"       varchar(16) NOT NULL,
  "name"       varchar(64),
  "dm_key"     varchar(80),
  "created_by" varchar(20) NOT NULL,
  "visibility" varchar(16) NOT NULL DEFAULT 'public',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_conversation" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_conversation_org_type" ON "conversation" ("org_id", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_conversation_org_dm_key"
  ON "conversation" ("org_id", "dm_key") WHERE "type" = 'dm';

-- ---------------------------------------------------------------------------
-- conversation_member
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "conversation_member" (
  "id"              varchar(20) NOT NULL,
  "conversation_id" varchar(20) NOT NULL,
  "user_id"         varchar(20) NOT NULL,
  "last_read_at"    timestamptz,
  "joined_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_conversation_member" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_conversation_member_conv_user"
  ON "conversation_member" ("conversation_id", "user_id");

-- ---------------------------------------------------------------------------
-- message
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "message" (
  "id"              varchar(20) NOT NULL,
  "conversation_id" varchar(20) NOT NULL,
  "sender_id"       varchar(20) NOT NULL,
  "content"         text        NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_message" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_message_conv_created_at" ON "message" ("conversation_id", "created_at");
