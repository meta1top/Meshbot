import type { PresenceState } from "@meshbot/types";

/**
 * 在线状态累积缓存：把下行 `im.presence` 事件（逐条 `{userId, online}`）折叠成
 * 一份 userId → online 的快照。纯逻辑（无 socket / React 依赖），供两端适配器
 * 复用，且可脱离真实 socket 单测累积语义。
 *
 * 语义：覆盖式——同一 userId 以最后一次收到的事件为准；不同 userId 互不影响。
 */
export class PresenceCache {
  private readonly state = new Map<string, boolean>();

  /** 应用一条 presence 事件。 */
  apply(event: PresenceState): void {
    this.state.set(event.userId, event.online);
  }

  /** 当前快照的只读副本（Map 形态，供 `ImTransport.presenceSnapshot` 直接返回）。 */
  snapshot(): Map<string, boolean> {
    return new Map(this.state);
  }

  /** 当前快照的 Record 形态，供 web-common IM 组件的 `presence` prop 直接消费。 */
  toRecord(): Record<string, boolean> {
    return Object.fromEntries(this.state);
  }
}
