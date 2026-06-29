-- 网盘文件公开分享短链（SP-D）。DBA 手动执行；幂等；snake_case；逻辑外键；id 雪花 varchar(20)。
CREATE TABLE IF NOT EXISTS "cloud_share_link" (
  "id"                  varchar(20)  NOT NULL,
  "token"               varchar(32)  NOT NULL,
  "node_id"             varchar(20)  NOT NULL,
  "org_id"              varchar(20)  NOT NULL,
  "created_by_user_id"  varchar(20)  NOT NULL,
  "password_hash"       varchar(255),
  "expires_at"          timestamptz,
  "created_at"          timestamptz  NOT NULL DEFAULT now(),
  "revoked_at"          timestamptz,
  CONSTRAINT "pk_cloud_share_link" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cloud_share_link_token" ON "cloud_share_link" ("token");
CREATE INDEX IF NOT EXISTS "ix_cloud_share_link_node" ON "cloud_share_link" ("node_id");
