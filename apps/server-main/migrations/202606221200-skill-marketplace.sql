-- skill 市场（SP3-3b）。DBA 手动执行；幂等；snake_case；逻辑外键；id 为雪花 varchar(20)。
CREATE TABLE IF NOT EXISTS "skill_package" (
  "id"             varchar(20)  NOT NULL,
  "slug"           varchar(64)  NOT NULL,
  "display_name"   varchar(128) NOT NULL,
  "description"    text         NOT NULL,
  "author_user_id" varchar(20)  NOT NULL,
  "latest_version" varchar(32)  NOT NULL,
  "public"         boolean      NOT NULL DEFAULT true,
  "downloads"      integer      NOT NULL DEFAULT 0,
  "created_at"     timestamptz  NOT NULL DEFAULT now(),
  "updated_at"     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_skill_package" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_package_slug" ON "skill_package" ("slug");
CREATE INDEX IF NOT EXISTS "idx_skill_package_public_downloads" ON "skill_package" ("public", "downloads" DESC);

CREATE TABLE IF NOT EXISTS "skill_version" (
  "id"          varchar(20)  NOT NULL,
  "package_id"  varchar(20)  NOT NULL,
  "version"     varchar(32)  NOT NULL,
  "asset_key"   varchar(256) NOT NULL,
  "checksum"    varchar(64)  NOT NULL,
  "size_bytes"  integer      NOT NULL,
  "readme"      text         NOT NULL,
  "changelog"   text,
  "created_at"  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_skill_version" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_version_pkg_ver" ON "skill_version" ("package_id", "version");
