-- 云端 Agent 注册表(计划二:设备侧 remote_enabled Agent 元数据全量推送对账)。
-- DBA 手动执行;幂等;snake_case;逻辑外键;id 雪花 varchar(20);deleted_at 软删。
CREATE TABLE IF NOT EXISTS "agent" (
  "id"              varchar(20)  NOT NULL,
  "device_id"       varchar(20)  NOT NULL,
  "user_id"         varchar(20)  NOT NULL,
  "org_id"          varchar(20),
  "local_agent_id"  varchar(20)  NOT NULL,
  "name"            varchar(128) NOT NULL,
  "avatar"          varchar(64)  NOT NULL DEFAULT '',
  "description"     text,
  "visibility"      varchar(16)  NOT NULL DEFAULT 'private',
  "last_synced_at"  timestamptz,
  "deleted_at"      timestamptz,
  "created_at"      timestamptz  NOT NULL DEFAULT now(),
  "updated_at"      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_agent" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_device_local"
  ON "agent" ("device_id", "local_agent_id") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "ix_agent_device" ON "agent" ("device_id");
CREATE INDEX IF NOT EXISTS "ix_agent_user" ON "agent" ("user_id");
