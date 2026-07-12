import type {
  ChannelMember,
  ConversationSummary,
  ImConversationReadEvent,
  ImMessage,
  PresenceState,
} from "@meshbot/types";

/** IM 事件订阅回调集（信封/WS 事件由适配器归一后调用）。 */
export interface ImTransportEvents {
  onMessage: (m: ImMessage) => void;
  onPresence: (p: PresenceState) => void;
  onConversationCreated: (c: ConversationSummary) => void;
  onConversationRemoved: (conversationId: string) => void;
  onConversationRead: (e: ImConversationReadEvent) => void;
}

/** IM 数据传输接口：UI 组件唯一的数据入口，两端各自实现。 */
export interface ImTransport {
  listConversations(): Promise<ConversationSummary[]>;
  listMessages(
    conversationId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<{ messages: ImMessage[]; hasMore: boolean }>;
  send(conversationId: string, content: string): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  createDm(userId: string): Promise<ConversationSummary>;
  /** visibility 缺省 "public"（不传即建公开频道，与后端 CreateChannelSchema 默认值一致）。 */
  createChannel(
    name: string,
    memberIds: string[],
    visibility?: "public" | "private",
  ): Promise<ConversationSummary>;
  addChannelMember(conversationId: string, userId: string): Promise<void>;
  /** 退出私有频道（自身）。 */
  leaveChannel(conversationId: string): Promise<void>;
  listChannelMembers(conversationId: string): Promise<ChannelMember[]>;
  /** 订阅事件；返回退订函数。适配器负责连接生命周期。 */
  subscribe(events: Partial<ImTransportEvents>): () => void;
  /** 当前在线快照（适配器缓存的 presence 状态）。 */
  presenceSnapshot(): Map<string, boolean>;
}

/** 多订阅者分发器：适配器内部复用（subscribe 多次调用互不覆盖）。 */
export class ImEventHub {
  private subscribers = new Set<Partial<ImTransportEvents>>();

  /**
   * 注册一组回调；返回退订函数。
   */
  on(events: Partial<ImTransportEvents>): () => void {
    this.subscribers.add(events);

    return () => {
      this.subscribers.delete(events);
    };
  }

  /**
   * 分发单个事件到全部订阅者（逐个 try/catch 隔离，单个回调抛错不影响其余）。
   */
  emit<K extends keyof ImTransportEvents>(
    kind: K,
    ...args: Parameters<ImTransportEvents[K]>
  ): void {
    for (const subscriber of this.subscribers) {
      const callback = subscriber[kind];
      if (callback) {
        try {
          (callback as any)(...args);
        } catch (error) {
          // 隔离错误，防止一个订阅者的错误影响其他订阅者
          console.error(`Error in ImEventHub subscriber for ${kind}:`, error);
        }
      }
    }
  }
}
