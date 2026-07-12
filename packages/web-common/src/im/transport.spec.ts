import type {
  ConversationSummary,
  ImConversationReadEvent,
  ImMessage,
  PresenceState,
} from "@meshbot/types";
import { ImEventHub } from "./transport";

describe("ImEventHub", () => {
  let hub: ImEventHub;

  beforeEach(() => {
    hub = new ImEventHub();
  });

  it("应该让多个订阅者都收到事件", () => {
    const message: ImMessage = {
      id: "1",
      conversationId: "conv-1",
      content: "test",
      senderId: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const callback1 = jest.fn();
    const callback2 = jest.fn();

    hub.on({ onMessage: callback1 });
    hub.on({ onMessage: callback2 });

    hub.emit("onMessage", message);

    expect(callback1).toHaveBeenCalledWith(message);
    expect(callback2).toHaveBeenCalledWith(message);
  });

  it("退订后不应该再收到事件", () => {
    const message: ImMessage = {
      id: "1",
      conversationId: "conv-1",
      content: "test",
      senderId: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const callback = jest.fn();
    const unsubscribe = hub.on({ onMessage: callback });

    hub.emit("onMessage", message);
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();

    hub.emit("onMessage", message);
    expect(callback).toHaveBeenCalledTimes(1); // 仍然只调用1次
  });

  it("应该支持 Partial 回调（缺省的事件类型不炸）", () => {
    const message: ImMessage = {
      id: "1",
      conversationId: "conv-1",
      content: "test",
      senderId: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const presence: PresenceState = {
      userId: "user-1",
      online: true,
    };

    const onMessage = jest.fn();
    const onPresence = jest.fn();

    // 订阅器1只关心消息
    hub.on({ onMessage });

    // 订阅器2只关心在线状态
    hub.on({ onPresence });

    // 分发消息，不应该报错
    hub.emit("onMessage", message);
    expect(onMessage).toHaveBeenCalledWith(message);
    expect(onPresence).not.toHaveBeenCalled();

    // 分发在线状态，不应该报错
    hub.emit("onPresence", presence);
    expect(onPresence).toHaveBeenCalledWith(presence);
    expect(onMessage).toHaveBeenCalledTimes(1); // 消息回调不应再被调用
  });

  it("单个回调抛错不应影响其他订阅者", () => {
    const message: ImMessage = {
      id: "1",
      conversationId: "conv-1",
      content: "test",
      senderId: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const errorCallback = jest.fn(() => {
      throw new Error("test error");
    });
    const normalCallback = jest.fn();

    hub.on({ onMessage: errorCallback });
    hub.on({ onMessage: normalCallback });

    // emit 时应该不抛错，虽然第一个回调出错了
    expect(() => hub.emit("onMessage", message)).not.toThrow();

    expect(errorCallback).toHaveBeenCalledWith(message);
    expect(normalCallback).toHaveBeenCalledWith(message);
  });
});
