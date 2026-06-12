-- =============================================================================
-- meshbot server-main 初始 schema（Phase 1：云端身份 + 企业/组织）
--
-- 执行方式：DBA 手动执行（psql -f 202606130244-init-identity-and-org.sql），
-- 服务不自动建表。规则见 .claude/skills/ddl-migration/SKILL.md：
--   - 全部语句幂等（IF NOT EXISTS / IF EXISTS），重复执行安全
--   - 列名 snake_case；无数据库外键约束（逻辑外键）
--   - 文件一经提交不可修改，后续变更追加新的 <YYYYMMDDHHmm>-<english-summary>.sql
-- =============================================================================

-- gen_random_uuid()（PostgreSQL 13+ 内置，扩展兜底旧版本）
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- 云端用户
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "app_user" (
  "id"            uuid          NOT NULL DEFAULT gen_random_uuid(),
  "email"         varchar(255)  NOT NULL,
  "password_hash" varchar(255)  NOT NULL,
  "display_name"  varchar(64)   NOT NULL,
  "active_org_id" uuid,
  "created_at"    timestamptz   NOT NULL DEFAULT now(),
  "updated_at"    timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT "pk_app_user" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_user_email" ON "app_user" ("email");

-- 兼容旧库（app_user 已存在但无 active_org_id 列）
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "active_org_id" uuid;

-- ---------------------------------------------------------------------------
-- 企业/组织（单层）。owner_id 与 membership.role=owner 冗余，便于直查
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "organization" (
  "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
  "name"       varchar(64)  NOT NULL,
  "owner_id"   uuid         NOT NULL,
  "created_at" timestamptz  NOT NULL DEFAULT now(),
  "updated_at" timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_organization" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 用户↔组织 多对多成员关系
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "membership" (
  "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
  "org_id"     uuid         NOT NULL,
  "user_id"    uuid         NOT NULL,
  "role"       varchar(16)  NOT NULL,
  "created_at" timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_membership" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_membership_org_user" ON "membership" ("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_membership_user" ON "membership" ("user_id");

-- ---------------------------------------------------------------------------
-- 组织邀请。token 即邮件邀请码
-- ---------------------------------------------------------------------------
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
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_token" ON "invitation" ("token");
-- 同组织同邮箱仅允许一条 pending（防重复邀请）
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_org_email_pending"
  ON "invitation" ("org_id", "email") WHERE "status" = 'pending';
