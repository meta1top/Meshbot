import { z } from "zod";

/** 浏览器 ↔ server-agent 全局事件总线 namespace。注意：不同于 server-main/relay 的 ws/im。 */
export const EVENTS_WS_NAMESPACE = "ws/events";

/**
 * 全局事件总线信封：下行单一事件名 `event` 的统一载荷。
 * type = 事件常量值（如 im.message / im.conversation_read / schedule.fired）；
 * payload 由各 type 自行约束；ts 为毫秒时间戳。
 */
export const GlobalEventEnvelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
  ts: z.number(),
});

export type GlobalEventEnvelope = z.infer<typeof GlobalEventEnvelopeSchema>;
