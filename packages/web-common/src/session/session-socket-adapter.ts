import type { SessionSocketLike } from "./socket-like";
import type { SessionTransport } from "./transport";

/**
 * 把 `SessionTransport.subscribe()`（单一 `onEvent(event, payload)` 帧流）桥接成
 * `useSessionStream` 期望的 {@link SessionSocketLike} 形态（具名事件 `on`/`off`/`emit`）。
 *
 * 背景：`useSessionStream` 的事件入口固定是 `getSocket(): SessionSocketLike`——
 * web-agent 传入真实 `socket.io-client` `Socket`（天然满足该接口：具名事件、真实
 * 连接生命周期）。remote-only 场景（web-main）没有这样一条独立的 `ws/session`
 * 连接，帧流经 `SessionTransport.subscribe()` 的单一回调统一到达（内部已按
 * `RemoteRunTracker` 做流归属过滤 + 乱序重排，事件名即 `SESSION_WS_EVENTS.*`
 * 值，payload 原样）。本适配器按事件名把这个单一回调分发给通过 `on()` 注册的
 * 各个 listener，使 `useSessionStream` 可以零改动消费 remote-only transport。
 *
 * 关键设计：
 * - **惰性订阅**：直到第一次 `on()` 调用才真正调用 `transport.subscribe()`。
 *   `SessionTransport.subscribe()` 内部是 `MulticastRunEvents`（Set 语义，
 *   任意数量并发订阅者各自独立、互不覆盖，见 `createRemoteSessionTransport`）
 *   ——并发订阅本身不会互相冲突，惰性只是避免在还没有真实 listener 时就
 *   白登记一路空转的订阅；`ensureSubscribed()` 只在首次 `on()` 时调用一次，
 *   之后的 `on()` 复用同一路。
 * - **`connected` 恒为 `true`**：远程流的可用性由 transport 内部的 socket 单例
 *   自行管理（`getImSocket()` 常驻连接），不依赖 `useSessionStream` 感知的
 *   显式握手时序，adapter 对外呈现「随时已连接」。
 * - **`emit()` 为 no-op**：`useSessionStream` 唯一会 `emit` 的两个事件是
 *   `SESSION_WS_EVENTS.subscribe`/`unsubscribe`（本地会话的 socket.io room
 *   语义）；远程流按 `streamId`（非 room）关联，无需该握手。
 *
 * 每个 adapter 实例绑定一个 transport 实例；多个消费方共享同一个 transport
 * 时（如父会话视图与嵌套子代理卡，见 `remote-subagent-card.tsx`），各自
 * 新建的 adapter 实例各登记一路独立订阅、互不干扰（`MulticastRunEvents`
 * 保证）。调用方应对同一 transport 用 `useMemo` 稳定复用同一个 adapter
 * （与 transport 的既有惯例一致）。
 */
export function createSessionSocketAdapter(
  transport: SessionTransport,
): SessionSocketLike {
  // biome-ignore lint/suspicious/noExplicitAny: 镜像 SessionSocketLike 的 on/off listener 签名
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let subscribed = false;

  const ensureSubscribed = () => {
    if (subscribed) return;
    subscribed = true;
    transport.subscribe({
      onEvent(event, payload) {
        const set = listeners.get(event);
        // PROBE-TS 临时排查埋点（云端工具卡永不收敛）——定位后整块删除
        if (event.startsWith("run.tool_call")) {
          const p = payload as {
            sessionId?: string;
            messageId?: string;
            toolCallId?: string;
          };
          console.warn(
            `[PROBE-TS][adapter] ${event} listeners=${set?.size ?? 0} sid=${p?.sessionId} msg=${p?.messageId} tc=${p?.toolCallId}`,
          );
        }
        if (!set || set.size === 0) return;
        // 拷贝一份快照再遍历：listener 内部同步 off() 自身（如一次性监听）
        // 不应影响本次分发的其余 listener。
        for (const listener of [...set]) listener(payload);
      },
    });
  };

  return {
    connected: true,
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      ensureSubscribed();
      return this;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    emit() {
      // no-op：见上方类文档。
      return this;
    },
  };
}
