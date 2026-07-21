import {
  SESSION_LIFECYCLE_EVENTS,
  SESSION_STATUS_EVENTS,
  SessionCreatedEventSchema,
  SessionDeletedEventSchema,
  SessionRenamedEventSchema,
  type SessionStatus,
  SessionStatusChangedEventSchema,
  type SessionSummary,
} from "@meshbot/types-agent";

/**
 * 归一后的会话列表变更事件（spec D9「统一事件契约」的前端形态）。
 *
 * **本地与远程共用同一份**：本地 Agent 的生命周期事件来自 `ws/events` 信封，
 * 远程 Agent 的来自 relay 的 Agent 级 watch 镜像帧——两条传输、一套模型，
 * 上层（会话列表 atom / react-query 缓存）只认这一个类型，不必知道 Agent 是
 * 本地还是远程。
 */
export type SessionListEvent =
  | { type: "created"; session: SessionSummary }
  | { type: "deleted"; sessionId: string }
  | { type: "renamed"; sessionId: string; title: string }
  | { type: "status_changed"; sessionId: string; status: SessionStatus };

/**
 * 把原始 `(event, payload)` 归一成 {@link SessionListEvent}；不是生命周期
 * 事件（如推理帧）返回 null。
 *
 * payload 走 zod 校验而非裸断言：relay 那条路上它是 `unknown` 透传，形状不符
 * 时返回 null 静默跳过，绝不让一条畸形帧把整个列表更新链路打断。
 */
export function toSessionListEvent(
  event: string,
  payload: unknown,
): SessionListEvent | null {
  if (event === SESSION_LIFECYCLE_EVENTS.created) {
    const p = SessionCreatedEventSchema.safeParse(payload);
    return p.success ? { type: "created", session: p.data.session } : null;
  }
  if (event === SESSION_LIFECYCLE_EVENTS.deleted) {
    const p = SessionDeletedEventSchema.safeParse(payload);
    return p.success ? { type: "deleted", sessionId: p.data.sessionId } : null;
  }
  if (event === SESSION_LIFECYCLE_EVENTS.renamed) {
    const p = SessionRenamedEventSchema.safeParse(payload);
    return p.success
      ? { type: "renamed", sessionId: p.data.sessionId, title: p.data.title }
      : null;
  }
  if (event === SESSION_STATUS_EVENTS.changed) {
    const p = SessionStatusChangedEventSchema.safeParse(payload);
    return p.success
      ? {
          type: "status_changed",
          sessionId: p.data.sessionId,
          status: p.data.status,
        }
      : null;
  }
  return null;
}

/**
 * 把一条生命周期事件应用到会话列表，返回**新数组**（不可变，直接喂 React
 * state / 前端全局状态管理的 atom）。
 *
 * 语义细节：
 * - `created` 插到最前（新会话在顶，与列表的 updatedAt 倒序一致），同 id 幂等
 *   （relay 重连补发 + 本地事件可能各来一次）。
 * - 其余三类对**列表里没有的会话**一律忽略：不凭空造一行残缺数据——观察者
 *   可能只加载了部分会话（分页/筛选），也可能这条会话属于别的 Agent。
 */
export function applySessionListEvent(
  list: SessionSummary[],
  evt: SessionListEvent,
): SessionSummary[] {
  if (evt.type === "created") {
    if (list.some((s) => s.id === evt.session.id)) return list;
    return [evt.session, ...list];
  }
  if (evt.type === "deleted") {
    if (!list.some((s) => s.id === evt.sessionId)) return list;
    return list.filter((s) => s.id !== evt.sessionId);
  }
  if (!list.some((s) => s.id === evt.sessionId)) return list;
  return list.map((s) => {
    if (s.id !== evt.sessionId) return s;
    if (evt.type === "renamed") {
      return { ...s, title: evt.title, titleGenerated: true };
    }
    return { ...s, status: evt.status };
  });
}
