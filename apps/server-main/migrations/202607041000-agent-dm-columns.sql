-- 设备 Agent 反向通道(子项目 B):IM 表加列。DBA 手动执行;幂等;snake_case。
-- agent_device_id 有值 = 该会话是"人 ↔ 设备 Agent"的 DM(值为目标设备 id)。
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "agent_device_id" varchar(20);
CREATE INDEX IF NOT EXISTS "ix_conversation_agent_device" ON "conversation" ("agent_device_id");

-- sender_type:人发 'user' / Agent 回 'agent';存量行默认 'user'。
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "sender_type" varchar(8) NOT NULL DEFAULT 'user';
