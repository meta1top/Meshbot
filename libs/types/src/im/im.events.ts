import type {
  ConversationSummary,
  ImMessage,
  PresenceState,
} from "./im.schema";

export const IM_WS_NAMESPACE = "ws/im";

export const IM_WS_EVENTS = {
  // server → client（下行；server-agent EventEmitter2 上也用这套名）
  message: "im.message",
  presence: "im.presence",
  conversationCreated: "im.conversation_created",
  conversationRemoved: "im.conversation_removed",
  // client → server（上行）
  send: "im.send",
  read: "im.read",
  ping: "im.ping",
} as const;

// 下行事件 payload
export type ImMessageEvent = ImMessage;
export type ImPresenceEvent = PresenceState;
export type ImConversationCreatedEvent = ConversationSummary;

// 历史分页响应
export interface MessagePage {
  messages: ImMessage[];
  hasMore: boolean;
}
