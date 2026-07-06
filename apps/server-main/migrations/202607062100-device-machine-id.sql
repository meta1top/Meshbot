-- DBA 手动执行;幂等;snake_case;逻辑外键;文件不可变。
-- Device 加 machine_id(本机指纹,同机同账号去重键)+ 部分唯一索引。
-- 仅约束未吊销且有 machine_id 的行,老行(machine_id 为 null)与已吊销行不占索引。

ALTER TABLE "device" ADD COLUMN IF NOT EXISTS "machine_id" varchar(80);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_device_user_machine"
  ON "device" ("user_id", "machine_id")
  WHERE "revoked_at" IS NULL AND "machine_id" IS NOT NULL;
