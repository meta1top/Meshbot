-- =============================================================================
-- meshbot server-main IM schema（Phase 2：会话 / 会话成员 / 消息）
--
-- 执行方式：DBA 手动执行（psql -f 202606142038-im-conversations.sql），
-- 服务不自动建表。规则：
--   - 全部语句幂等（IF NOT EXISTS），重复执行安全
--   - 列名 snake_case；无数据库外键约束（逻辑外键）
--   - 文件一经提交不可修改，后续变更追加新的 <YYYYMMDDHHmm>-<english-summary>.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 会话（频道或 DM）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "conversation" (
  "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
  "org_id"     uuid         NOT NULL,
  "type"       varchar(16)  NOT NULL,
  "name"       varchar(64),
  "dm_key"     varchar(80),
  "created_by" uuid         NOT NULL,
  "created_at" timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_conversation" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_conversation_org_type" ON "conversation" ("org_id", "type");
-- DM 去重：同一 org 下相同 dm_key 只允许一条 DM 会话
CREATE UNIQUE INDEX IF NOT EXISTS "idx_conversation_org_dm_key"
  ON "conversation" ("org_id", "dm_key") WHERE "type" = 'dm';

-- ---------------------------------------------------------------------------
-- 会话成员关系
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "conversation_member" (
  "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" uuid         NOT NULL,
  "user_id"         uuid         NOT NULL,
  "last_read_at"    timestamptz,
  "joined_at"       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_conversation_member" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_conversation_member_conv_user"
  ON "conversation_member" ("conversation_id", "user_id");

-- ---------------------------------------------------------------------------
-- 消息
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "message" (
  "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" uuid         NOT NULL,
  "sender_id"       uuid         NOT NULL,
  "content"         text         NOT NULL,
  "created_at"      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_message" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_message_conv_created_at" ON "message" ("conversation_id", "created_at");
