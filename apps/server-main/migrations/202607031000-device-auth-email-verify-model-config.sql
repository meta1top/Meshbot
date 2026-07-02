-- 设备授权登录(device token)+ 注册邮箱验证 + 组织级模型配置(子项目 A)。
-- DBA 手动执行;幂等;snake_case;逻辑外键;id 雪花 varchar(20)。

-- 已授权设备:token 只存 SHA-256 hex,吊销置 revoked_at。
CREATE TABLE IF NOT EXISTS "device" (
  "id"            varchar(20)  NOT NULL,
  "user_id"       varchar(20)  NOT NULL,
  "org_id"        varchar(20),
  "name"          varchar(128) NOT NULL,
  "platform"      varchar(32)  NOT NULL DEFAULT '',
  "token_hash"    varchar(64)  NOT NULL,
  "last_seen_at"  timestamptz,
  "revoked_at"    timestamptz,
  "created_at"    timestamptz  NOT NULL DEFAULT now(),
  "updated_at"    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_device" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_device_token_hash" ON "device" ("token_hash");
CREATE INDEX IF NOT EXISTS "ix_device_user" ON "device" ("user_id");

-- 授权流程中间态:pending → approved → consumed;过期由 expires_at 判定。
CREATE TABLE IF NOT EXISTS "device_auth_request" (
  "id"               varchar(20)  NOT NULL,
  "status"           varchar(16)  NOT NULL DEFAULT 'pending',
  "device_name"      varchar(128) NOT NULL,
  "platform"         varchar(32)  NOT NULL DEFAULT '',
  "code_challenge"   varchar(64)  NOT NULL,
  "redirect_uri"     varchar(255),
  "user_code"        varchar(32),
  "user_id"          varchar(20),
  "attempts"         int          NOT NULL DEFAULT 0,
  "expires_at"       timestamptz  NOT NULL,
  "created_at"       timestamptz  NOT NULL DEFAULT now(),
  "updated_at"       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_device_auth_request" PRIMARY KEY ("id")
);

-- 注册邮箱验证码。
CREATE TABLE IF NOT EXISTS "email_verification" (
  "id"          varchar(20)  NOT NULL,
  "email"       varchar(255) NOT NULL,
  "code"        varchar(8)   NOT NULL,
  "attempts"    int          NOT NULL DEFAULT 0,
  "expires_at"  timestamptz  NOT NULL,
  "created_at"  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_email_verification" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ix_email_verification_email" ON "email_verification" ("email");

-- app_user 邮箱验证时间;存量用户回填为已验证。
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamptz;
UPDATE "app_user" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;

-- 组织级模型配置;api_key 应用层 AES-256-GCM 加密。
CREATE TABLE IF NOT EXISTS "org_model_config" (
  "id"              varchar(20)  NOT NULL,
  "org_id"          varchar(20)  NOT NULL,
  "name"            varchar(64)  NOT NULL,
  "provider_type"   varchar(32)  NOT NULL,
  "model"           varchar(128) NOT NULL,
  "api_key_enc"     text         NOT NULL,
  "base_url"        varchar(255) NOT NULL DEFAULT '',
  "context_window"  int          NOT NULL DEFAULT 128000,
  "enabled"         boolean      NOT NULL DEFAULT true,
  "created_at"      timestamptz  NOT NULL DEFAULT now(),
  "updated_at"      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_org_model_config" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ix_org_model_config_org" ON "org_model_config" ("org_id");
