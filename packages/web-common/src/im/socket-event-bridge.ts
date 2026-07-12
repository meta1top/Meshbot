import {
  type ConversationSummary,
  IM_WS_EVENTS,
  type ImConversationReadEvent,
  type ImMessage,
  type PresenceState,
} from "@meshbot/types";
import type { PresenceCache } from "./presence-cache";
import type { ImEventHub } from "./transport";

/**
 * socket.io-client `Socket` 的最小子集：仅本桥接需要的 `on`/`off`。
 * 单测注入伪对象（如手搓的小型 EventEmitter）时无需依赖真实 socket.io-client。
 * listener 形参用 `any[]`——真实 Socket 的 `on`/`off` 亦是此形状（未按事件名
 * 收窄的默认命名空间），收窄为具体 payload 类型会与之互不兼容。
 */
export interface ImSocketLike {
  // biome-ignore lint/suspicious/noExplicitAny: 镜像 socket.io-client Socket 的 on/off 形状
  on(event: string, listener: (...args: any[]) => void): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: 镜像 socket.io-client Socket 的 on/off 形状
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * 把 `ws/im` 原生下行事件桥接到 `ImEventHub`（归一为 `ImTransportEvents` 回调）+
 * `PresenceCache`（presence 累积）。纯事件路由逻辑，不含连接生命周期管理——
 * 由调用方（web-main `im-transport.ts`）负责 socket 的创建 / 鉴权 / 重连。
 *
 * 返回退订函数：仅卸载本次注册的 5 个监听器，不影响调用方自行注册的其他监听器。
 */
export function bridgeImSocketEvents(
  socket: ImSocketLike,
  hub: ImEventHub,
  presenceCache: PresenceCache,
): () => void {
  const onMessage = (m: ImMessage) => hub.emit("onMessage", m);
  const onPresence = (p: PresenceState) => {
    presenceCache.apply(p);
    hub.emit("onPresence", p);
  };
  const onConversationCreated = (c: ConversationSummary) =>
    hub.emit("onConversationCreated", c);
  const onConversationRemoved = (e: { conversationId: string }) =>
    hub.emit("onConversationRemoved", e.conversationId);
  const onConversationRead = (e: ImConversationReadEvent) =>
    hub.emit("onConversationRead", e);

  socket.on(IM_WS_EVENTS.message, onMessage);
  socket.on(IM_WS_EVENTS.presence, onPresence);
  socket.on(IM_WS_EVENTS.conversationCreated, onConversationCreated);
  socket.on(IM_WS_EVENTS.conversationRemoved, onConversationRemoved);
  socket.on(IM_WS_EVENTS.conversationRead, onConversationRead);

  return () => {
    socket.off(IM_WS_EVENTS.message, onMessage);
    socket.off(IM_WS_EVENTS.presence, onPresence);
    socket.off(IM_WS_EVENTS.conversationCreated, onConversationCreated);
    socket.off(IM_WS_EVENTS.conversationRemoved, onConversationRemoved);
    socket.off(IM_WS_EVENTS.conversationRead, onConversationRead);
  };
}
