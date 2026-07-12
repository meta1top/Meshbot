import type {
  ConversationSummary,
  ImConversationReadEvent,
  ImMessage,
  PresenceState,
} from "@meshbot/types";
import { IM_WS_EVENTS } from "@meshbot/types";
import { PresenceCache } from "./presence-cache";
import type { ImSocketLike } from "./socket-event-bridge";
import { bridgeImSocketEvents } from "./socket-event-bridge";
import { ImEventHub } from "./transport";

/** 极简伪 socket：仅实现 `ImSocketLike` 需要的 on/off + 手动触发事件的 emit。 */
class FakeSocket implements ImSocketLike {
  // biome-ignore lint/suspicious/noExplicitAny: 桥接层本身即宽泛 payload 形状
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  // biome-ignore lint/suspicious/noExplicitAny: 见类型声明处注释
  on(event: string, listener: (...args: any[]) => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  // biome-ignore lint/suspicious/noExplicitAny: 见类型声明处注释
  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  /** 触发事件，模拟服务端下行推送。 */
  trigger(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

describe("bridgeImSocketEvents", () => {
  let socket: FakeSocket;
  let hub: ImEventHub;
  let presenceCache: PresenceCache;

  beforeEach(() => {
    socket = new FakeSocket();
    hub = new ImEventHub();
    presenceCache = new PresenceCache();
  });

  it("im.message 归一为 onMessage", () => {
    bridgeImSocketEvents(socket, hub, presenceCache);
    const onMessage = jest.fn();
    hub.on({ onMessage });

    const message: ImMessage = {
      id: "m1",
      conversationId: "conv-1",
      senderId: "user-1",
      content: "hi",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    socket.trigger(IM_WS_EVENTS.message, message);

    expect(onMessage).toHaveBeenCalledWith(message);
  });

  it("im.presence 归一为 onPresence，同时累积进 presenceCache", () => {
    bridgeImSocketEvents(socket, hub, presenceCache);
    const onPresence = jest.fn();
    hub.on({ onPresence });

    const presence: PresenceState = { userId: "user-1", online: true };
    socket.trigger(IM_WS_EVENTS.presence, presence);

    expect(onPresence).toHaveBeenCalledWith(presence);
    expect(presenceCache.snapshot().get("user-1")).toBe(true);
  });

  it("im.conversation_created 归一为 onConversationCreated（原样透传整个 summary）", () => {
    bridgeImSocketEvents(socket, hub, presenceCache);
    const onConversationCreated = jest.fn();
    hub.on({ onConversationCreated });

    const summary: ConversationSummary = {
      id: "conv-1",
      type: "channel",
      visibility: "public",
      name: "general",
      peer: null,
      unreadCount: 0,
      lastMessage: null,
    };
    socket.trigger(IM_WS_EVENTS.conversationCreated, summary);

    expect(onConversationCreated).toHaveBeenCalledWith(summary);
  });

  it("im.conversation_removed 归一为 onConversationRemoved（从 {conversationId} 拆出裸字符串）", () => {
    bridgeImSocketEvents(socket, hub, presenceCache);
    const onConversationRemoved = jest.fn();
    hub.on({ onConversationRemoved });

    socket.trigger(IM_WS_EVENTS.conversationRemoved, {
      conversationId: "conv-1",
    });

    expect(onConversationRemoved).toHaveBeenCalledWith("conv-1");
  });

  it("im.conversation_read 归一为 onConversationRead", () => {
    bridgeImSocketEvents(socket, hub, presenceCache);
    const onConversationRead = jest.fn();
    hub.on({ onConversationRead });

    const event: ImConversationReadEvent = {
      conversationId: "conv-1",
      lastReadAt: "2026-01-01T00:00:00.000Z",
    };
    socket.trigger(IM_WS_EVENTS.conversationRead, event);

    expect(onConversationRead).toHaveBeenCalledWith(event);
  });

  it("退订函数只卸载本次注册的 5 个监听器", () => {
    const unsubscribe = bridgeImSocketEvents(socket, hub, presenceCache);

    expect(socket.listenerCount(IM_WS_EVENTS.message)).toBe(1);
    expect(socket.listenerCount(IM_WS_EVENTS.presence)).toBe(1);
    expect(socket.listenerCount(IM_WS_EVENTS.conversationCreated)).toBe(1);
    expect(socket.listenerCount(IM_WS_EVENTS.conversationRemoved)).toBe(1);
    expect(socket.listenerCount(IM_WS_EVENTS.conversationRead)).toBe(1);

    unsubscribe();

    expect(socket.listenerCount(IM_WS_EVENTS.message)).toBe(0);
    expect(socket.listenerCount(IM_WS_EVENTS.presence)).toBe(0);
    expect(socket.listenerCount(IM_WS_EVENTS.conversationCreated)).toBe(0);
    expect(socket.listenerCount(IM_WS_EVENTS.conversationRemoved)).toBe(0);
    expect(socket.listenerCount(IM_WS_EVENTS.conversationRead)).toBe(0);
  });

  it("退订后事件不再归一分发", () => {
    const unsubscribe = bridgeImSocketEvents(socket, hub, presenceCache);
    const onMessage = jest.fn();
    hub.on({ onMessage });

    unsubscribe();

    socket.trigger(IM_WS_EVENTS.message, {
      id: "m1",
      conversationId: "conv-1",
      senderId: "user-1",
      content: "hi",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
});
