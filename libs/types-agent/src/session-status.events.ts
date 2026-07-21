import { z } from "zod";
import { SessionStatus } from "./session";

/**
 * server-agent 本地事件：会话运行状态变更（idle ↔ running）。
 *
 * 走 ws/events 全局总线（非 ws/session 会话房间）：侧栏「运行中」绿点在
 * /home、消息页等任何路由都要实时落态，而 ws/session 只在会话页挂载时建连。
 */
export const SESSION_STATUS_EVENTS = {
  changed: "session.status_changed",
} as const;

export const SessionStatusChangedEventSchema = z.object({
  /**
   * 会话归属的 Agent id。纳入统一生命周期契约（spec §A）后必填：云端按
   * `${deviceId}:${localAgentId}` 键做 Agent 级 fan-out，缺了无法路由到观察者。
   */
  agentId: z.string(),
  sessionId: z.string(),
  status: SessionStatus,
});

export type SessionStatusChangedEvent = z.infer<
  typeof SessionStatusChangedEventSchema
>;
