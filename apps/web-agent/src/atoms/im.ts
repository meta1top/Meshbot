"use client";

import type {
  ConversationSummary,
  ImMessage,
  PresenceState,
} from "@meshbot/types";
import { atom } from "jotai";
import { fetchConversations } from "@/rest/im";

/** 全部会话列表（最近消息时间 desc 排序）。 */
export const conversationsAtom = atom<ConversationSummary[]>([]);

/** 当前激活的会话 id，null 表示未选中。 */
export const currentConversationIdAtom = atom<string | null>(null);

/** 派生：当前会话完整对象。 */
export const currentConversationAtom = atom<ConversationSummary | null>(
  (get) => {
    const id = get(currentConversationIdAtom);
    if (!id) return null;
    return get(conversationsAtom).find((c) => c.id === id) ?? null;
  },
);

/** 当前会话的消息列表（按 createdAt asc）。 */
export const messagesAtom = atom<ImMessage[]>([]);

/** 在线状态：userId → online。 */
export const presenceAtom = atom<Record<string, boolean>>({});

// ─── 排序辅助 ────────────────────────────────────────────────────────────────

/** 按 lastMessage.createdAt desc，无 lastMessage 的靠后再按 name 排。 */
export function sortConversations(
  arr: ConversationSummary[],
): ConversationSummary[] {
  if (!Array.isArray(arr)) return [];
  return [...arr].sort((a, b) => {
    const aTime = a.lastMessage?.createdAt ?? "";
    const bTime = b.lastMessage?.createdAt ?? "";
    if (bTime !== aTime) return bTime.localeCompare(aTime);
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

// ─── Write-only action atoms ──────────────────────────────────────────────────

/**
 * 拉取会话列表并写入 conversationsAtom（排序后）。
 */
export const loadConversationsAtom = atom(null, async (_get, set) => {
  try {
    const arr = await fetchConversations();
    set(conversationsAtom, sortConversations(arr));
  } catch {
    // 拉取失败（未登录云端 / 网络错误 / 云端未启动）时降级为空列表，
    // 不抛出，避免 page.tsx 里 `void loadConversations()` 产生 unhandledRejection。
    set(conversationsAtom, []);
  }
});

/**
 * UPSERT 单条会话（按 id 去重）。
 * - 已存在：原地替换（保持列表整体顺序不变，再重排）。
 * - 不存在：prepend 后重排。
 * 服务端可能对已存在的 DM 再发 conversationCreated，所以必须去重。
 */
export const upsertConversationAtom = atom(
  null,
  (get, set, conversation: ConversationSummary) => {
    const arr = get(conversationsAtom);
    const idx = arr.findIndex((c) => c.id === conversation.id);
    let next: ConversationSummary[];
    if (idx >= 0) {
      next = arr.map((c) => (c.id === conversation.id ? conversation : c));
    } else {
      next = [conversation, ...arr];
    }
    set(conversationsAtom, sortConversations(next));
  },
);

/**
 * 处理下行 IM 消息：
 * 1. 若消息属于当前会话 → 追加到 messagesAtom（按 id 去重）。
 * 2. 更新 conversationsAtom 中对应会话的 lastMessage + unreadCount。
 */
export const applyIncomingMessageAtom = atom(
  null,
  (get, set, message: ImMessage) => {
    const currentId = get(currentConversationIdAtom);

    // 1. 追加到当前会话消息列表（dedup by id）
    if (message.conversationId === currentId) {
      const msgs = get(messagesAtom);
      if (!msgs.some((m) => m.id === message.id)) {
        set(messagesAtom, [...msgs, message]);
      }
    }

    // 2. 更新会话列表中的 lastMessage + unreadCount
    const conversations = get(conversationsAtom);
    const idx = conversations.findIndex((c) => c.id === message.conversationId);
    if (idx >= 0) {
      const conv = conversations[idx];
      const isCurrentConv = message.conversationId === currentId;
      const updated: ConversationSummary = {
        ...conv,
        lastMessage: {
          content: message.content,
          senderId: message.senderId,
          createdAt: message.createdAt,
        },
        // 当前打开的会话不增加未读
        unreadCount: isCurrentConv ? conv.unreadCount : conv.unreadCount + 1,
      };
      const next = conversations.map((c) =>
        c.id === message.conversationId ? updated : c,
      );
      set(conversationsAtom, sortConversations(next));
    }
  },
);

/**
 * 更新在线状态，合并到 presenceAtom。
 */
export const setPresenceAtom = atom(null, (get, set, state: PresenceState) => {
  set(presenceAtom, { ...get(presenceAtom), [state.userId]: state.online });
});

/**
 * 移除指定会话（退出私有频道时调用）。
 * - 从 conversationsAtom 中删除该 id。
 * - 若正在查看该会话，同时将 currentConversationIdAtom 复位为 null。
 */
export const removeConversationAtom = atom(
  null,
  (get, set, conversationId: string) => {
    const arr = get(conversationsAtom);
    set(
      conversationsAtom,
      arr.filter((c) => c.id !== conversationId),
    );
    if (get(currentConversationIdAtom) === conversationId) {
      set(currentConversationIdAtom, null);
    }
  },
);

/**
 * 乐观追加已发送消息（D4 可直接调用；去重逻辑与 applyIncomingMessageAtom 一致）。
 */
export const appendSentMessageAtom = atom(
  null,
  (get, set, message: ImMessage) => {
    const msgs = get(messagesAtom);
    if (msgs.some((m) => m.id === message.id)) return;
    set(messagesAtom, [...msgs, message]);
  },
);
