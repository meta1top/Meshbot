"use client";

import { IM_WS_EVENTS } from "@meshbot/types";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { currentUserAtom } from "@/atoms/auth";
import {
  currentConversationIdAtom,
  markConversationReadAtom,
  messagesAtom,
} from "@/atoms/im";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { ImMessageList } from "@/components/im/im-message-list";
import { getEventsSocket } from "@/lib/events-socket";
import { fetchMessages } from "@/rest/im";
import { useMembers } from "@/rest/org";

interface ImConversationBodyProps {
  /** 当前会话 ID，由 page 传入（渲染时必有）。 */
  id: string;
  /** 共享滚动容器 ref，由 AppShellLayout/page 传入。 */
  scrollRef: RefObject<HTMLDivElement | null>;
}

/** IM 会话主体：socket 订阅、历史分页、消息列表、粘底输入。不含外壳/header。 */
export function ImConversationBody({ id, scrollRef }: ImConversationBodyProps) {
  const t = useTranslations("messages");

  const setCurrentConversationId = useSetAtom(currentConversationIdAtom);
  const setMessages = useSetAtom(messagesAtom);
  const markConversationRead = useSetAtom(markConversationReadAtom);
  const messages = useAtomValue(messagesAtom);
  const currentUser = useAtomValue(currentUserAtom);

  const orgId = currentUser?.org?.id ?? null;
  const currentUserId = currentUser?.id ?? "";
  const { data: membersData } = useMembers(orgId);

  // Build members map: Record<userId, {displayName, email}>
  // Include current user + all org members
  const members = useMemo<
    Record<string, { displayName: string; email: string }>
  >(() => {
    const map: Record<string, { displayName: string; email: string }> = {};
    if (currentUser) {
      map[currentUser.id] = {
        displayName: currentUser.displayName,
        email: currentUser.email,
      };
    }
    if (membersData) {
      for (const m of membersData) {
        map[m.userId] = { displayName: m.displayName, email: m.email };
      }
    }
    return map;
  }, [currentUser, membersData]);

  const [draft, setDraft] = useState("");
  const chatInputRef = useRef<ChatInputHandle>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);

  const oldestMessageIdRef = useRef<string | null>(null);
  const hasMoreHistoryRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [stickToBottom, setStickToBottom] = useState(true);
  const initialScrollDoneRef = useRef(false);

  // 1. URL hydration: sync props.id → atom
  useEffect(() => {
    setCurrentConversationId(id);
  }, [id, setCurrentConversationId]);

  // conversations 由侧栏 MessagesSidebar 的 loadSidebarAtom（/api/sidebar 聚合）填充；
  // 实时订阅（message/presence/会话增删）已上移到 shell 级 useGlobalEvents（AppShellLayout），
  // 任何页面常驻。当前会话的消息追加由 applyIncomingMessage 内部按 currentId 统一处理，
  // 本组件不再单独订阅。

  // 4. Load history when conversation id changes
  useEffect(() => {
    // Reset state on conversation switch
    setMessages([]);
    oldestMessageIdRef.current = null;
    hasMoreHistoryRef.current = true;
    setHasMoreHistory(true);
    initialScrollDoneRef.current = false;

    let cancelled = false;

    void fetchMessages(id).then((page) => {
      if (cancelled) return;
      setMessages(page.messages);
      oldestMessageIdRef.current = page.messages[0]?.id ?? null;
      hasMoreHistoryRef.current = page.hasMore;
      setHasMoreHistory(page.hasMore);
    });

    // 标记已读：通知后端更新 lastReadAt + 本地乐观清零该会话未读 badge
    const socket = getEventsSocket();
    socket.emit(IM_WS_EVENTS.read, { conversationId: id });
    markConversationRead(id);

    return () => {
      cancelled = true;
    };
  }, [id, setMessages, markConversationRead]);

  // 5. History pagination: top-sentinel IntersectionObserver
  const loadMoreHistory = useCallback(async () => {
    if (!hasMoreHistoryRef.current) return;
    if (loadingMoreRef.current) return;
    const cursor = oldestMessageIdRef.current;
    if (!cursor) return;

    loadingMoreRef.current = true;
    const scroller = scrollRef.current;
    const prevScrollHeight = scroller?.scrollHeight ?? 0;
    const prevScrollTop = scroller?.scrollTop ?? 0;

    try {
      const page = await fetchMessages(id, cursor);
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const fresh = page.messages.filter((m) => !existingIds.has(m.id));
        return [...fresh, ...prev];
      });
      oldestMessageIdRef.current = page.messages[0]?.id ?? cursor;
      hasMoreHistoryRef.current = page.hasMore;
      setHasMoreHistory(page.hasMore);

      // Anchor scroll position after prepend
      requestAnimationFrame(() => {
        if (!scroller) return;
        const newScrollHeight = scroller.scrollHeight;
        scroller.scrollTop =
          prevScrollTop + (newScrollHeight - prevScrollHeight);
      });
    } catch (err) {
      console.error("加载更早消息失败", err);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [id, setMessages, scrollRef]);

  useEffect(() => {
    if (!hasMoreHistory) return;
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMoreHistory();
        }
      },
      { rootMargin: "100px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [loadMoreHistory, hasMoreHistory]);

  // 6. Send: emit via WS, no optimistic insert
  const handleSend = useCallback(
    (text: string) => {
      const socket = getEventsSocket();
      socket.emit(IM_WS_EVENTS.send, { conversationId: id, content: text });
      setDraft("");
    },
    [id],
  );

  // 7. Scroll-to-bottom on new messages
  useEffect(() => {
    if (!stickToBottom) return;
    if (messages.length === 0) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, stickToBottom]);

  // Bottom sentinel IO for stick-to-bottom detection
  useEffect(() => {
    const sentinel = bottomRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting ?? false;
        setStickToBottom(visible);
      },
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollRef]);

  return (
    <>
      <div className="flex w-full flex-1 flex-col">
        {hasMoreHistory && (
          <div
            ref={topSentinelRef}
            className="flex justify-center py-2 text-xs text-muted-foreground/60"
          />
        )}
        {!hasMoreHistory && messages.length > 0 && (
          <div className="py-2 text-center text-xs text-muted-foreground/40">
            {t("historyStart")}
          </div>
        )}
        <ImMessageList
          messages={messages}
          members={members}
          currentUserId={currentUserId}
        />
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-4 mt-auto w-full bg-background">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-b from-transparent to-background"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -bottom-4 h-4 bg-background"
        />
        <ChatInput
          ref={chatInputRef}
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          placeholder={t("inputPlaceholder")}
        />
      </div>
    </>
  );
}
