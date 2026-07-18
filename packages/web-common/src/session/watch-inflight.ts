import {
  type RunSnapshotEvent,
  RunSnapshotEventSchema,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";

/**
 * 把 `watch_accepted.inflight`（设备侧 `RunnerService.getInflight` 的
 * `InflightView`）合成一条 `run.snapshot` 事件（spec D7 中途续上）。
 *
 * 为什么合成 `run.snapshot` 而不是自定义事件：`useSessionStream` 已经有一条
 * 处理 `run.snapshot` 的成熟路径（本地会话中途订阅时 `session.gateway.ts`
 * 就是这么补发的），观察者复用它就能直接渲染半截输出 + 半截 tool args——
 * **前端上层处理逻辑一份**（spec D9 的统一契约落点），不必为远程观察另造
 * 一条渲染分支。
 *
 * 返回 null 的三种情况（都不是错误）：
 * - `inflight` 为 null/undefined —— 该会话当前没在跑；
 * - `messageId` 为 null —— 本轮 assistant 已 `recordAssistant` 落库，不再是活
 *   partial，历史接口会给出完整内容，当 inflight 重推会导致「思考中」误计时；
 * - 形状校验不过 —— relay 透传的是 `unknown`，防御性返回 null 而非抛错。
 */
export function inflightToSnapshotEvent(
  sessionId: string,
  inflight: unknown,
): { event: string; payload: RunSnapshotEvent } | null {
  if (!inflight || typeof inflight !== "object") return null;
  const view = inflight as { messageId?: unknown };
  if (typeof view.messageId !== "string") return null;
  const parsed = RunSnapshotEventSchema.safeParse({
    ...(inflight as Record<string, unknown>),
    sessionId,
  });
  if (!parsed.success) return null;
  return { event: SESSION_WS_EVENTS.runSnapshot, payload: parsed.data };
}
