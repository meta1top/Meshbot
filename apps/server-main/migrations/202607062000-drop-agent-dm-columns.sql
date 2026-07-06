-- 移除 Agent-DM(人↔设备 Agent 私聊反向通道):删 conversation.agent_device_id + message.sender_type。
-- 与 202607041000-agent-dm-columns.sql 配对回退。DBA 手动执行;幂等(IF EXISTS);文件不可变。
DROP INDEX IF EXISTS "ix_conversation_agent_device";
ALTER TABLE "conversation" DROP COLUMN IF EXISTS "agent_device_id";
ALTER TABLE "message" DROP COLUMN IF EXISTS "sender_type";
