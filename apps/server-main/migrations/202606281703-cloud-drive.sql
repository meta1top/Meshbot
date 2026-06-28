-- 企业网盘（SP-A）。DBA 手动执行；幂等；snake_case；逻辑外键；id 雪花 varchar(20)。
CREATE TABLE IF NOT EXISTS "cloud_node" (
  "id"             varchar(20)  NOT NULL,
  "org_id"         varchar(20)  NOT NULL,
  "owner_user_id"  varchar(20)  NOT NULL,
  "parent_id"      varchar(20),
  "type"           varchar(8)   NOT NULL,
  "name"           varchar(256) NOT NULL,
  "asset_key"      varchar(256),
  "size_bytes"     bigint       NOT NULL DEFAULT 0,
  "mime"           varchar(128),
  "checksum"       varchar(64),
  "status"         varchar(12)  NOT NULL DEFAULT 'ready',
  "created_at"     timestamptz  NOT NULL DEFAULT now(),
  "updated_at"     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_cloud_node" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_cloud_node_parent" ON "cloud_node" ("parent_id");
CREATE INDEX IF NOT EXISTS "idx_cloud_node_org" ON "cloud_node" ("org_id");

CREATE TABLE IF NOT EXISTS "cloud_node_grant" (
  "id"            varchar(20) NOT NULL,
  "node_id"       varchar(20) NOT NULL,
  "grantee_type"  varchar(8)  NOT NULL,
  "grantee_id"    varchar(20) NOT NULL,
  "permission"    varchar(8)  NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_cloud_node_grant" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_cloud_grant_node" ON "cloud_node_grant" ("node_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cloud_grant_unique" ON "cloud_node_grant" ("node_id", "grantee_type", "grantee_id");
