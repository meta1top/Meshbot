-- =============================================================================
-- meshbot server-main IM 私有频道：conversation 增加 visibility 列
-- 执行方式：DBA 手动执行（psql -f）。幂等、不可变。
-- =============================================================================
ALTER TABLE "conversation"
  ADD COLUMN IF NOT EXISTS "visibility" varchar(16) NOT NULL DEFAULT 'public';
