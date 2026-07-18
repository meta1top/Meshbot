import { z } from "zod";
import { SessionSummarySchema } from "./session";

/**
 * server-agent 本地事件：会话生命周期（新建 / 删除 / 改名）。
 *
 * 与 `SESSION_STATUS_EVENTS.changed` 一起构成 spec §A 的「统一事件契约」——
 * 本地端经 `ws/events` 全局总线消费，远程观察者经 relay 的 Agent 级 watch
 * 镜像消费，**前端上层处理逻辑一份**（spec D9）。
 *
 * 发射点在 `SessionService`（`createSession` / `deleteSession` / `patch`）而非
 * Controller——这样 REST 改名、远程 run 建会话（`RemoteRunInboundService`）、
 * 定时任务建会话、`AgentService.removeWithData` 级联删会话等**所有**路径自动
 * 共享同一个事件，不会再出现某条路径静默不通知的洞（同 `AGENT_EVENTS.changed`
 * 把发射点下沉到 Service 的理由）。
 *
 * 每个 payload 都带 `agentId`：云端按 `${deviceId}:${localAgentId}` 键做
 * Agent 级 fan-out，缺了无法路由；前端也据此判定该事件属于哪个 Agent 的视图。
 */
export const SESSION_LIFECYCLE_EVENTS = {
  created: "session.created",
  deleted: "session.deleted",
  renamed: "session.renamed",
} as const;

/** 会话新建：携带完整 SessionSummary，观察者可直接插入列表无需回查。 */
export const SessionCreatedEventSchema = z.object({
  agentId: z.string(),
  session: SessionSummarySchema,
});
export type SessionCreatedEvent = z.infer<typeof SessionCreatedEventSchema>;

/** 会话删除：只带 id，观察者从列表移除。 */
export const SessionDeletedEventSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
});
export type SessionDeletedEvent = z.infer<typeof SessionDeletedEventSchema>;

/** 会话改名：手动改名与 LLM 自动生成标题两条路径共用。 */
export const SessionRenamedEventSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  title: z.string(),
});
export type SessionRenamedEvent = z.infer<typeof SessionRenamedEventSchema>;
