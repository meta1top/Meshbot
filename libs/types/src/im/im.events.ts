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
  conversationRead: "im.conversation_read",
  // client → server（上行）
  send: "im.send",
  read: "im.read",
  ping: "im.ping",
  presenceSet: "im.presence_set",
  deviceQueryRequest: "device.query.request",
  deviceQueryResponse: "device.query.response",
  agentRunStart: "agent.run.start",
  agentRunFrame: "agent.run.frame",
  agentRunControl: "agent.run.control",
  agentRunEnd: "agent.run.end",
} as const;

// 下行事件 payload
export type ImMessageEvent = ImMessage;
export type ImPresenceEvent = PresenceState;
export type ImConversationCreatedEvent = ConversationSummary;
/** 某用户某会话已读（广播给该用户全部连接，用于多端清未读）。 */
export interface ImConversationReadEvent {
  conversationId: string;
  lastReadAt: string;
}

// 历史分页响应
export interface MessagePage {
  messages: ImMessage[];
  hasMore: boolean;
}

/** 上行：浏览器在线状态变更（server-agent 按浏览器连接数聚合后上报）。 */
export interface ImPresenceSetInput {
  online: boolean;
}
