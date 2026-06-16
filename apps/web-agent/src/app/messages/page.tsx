"use client";

import type {
  ConversationSummary,
  ImMessage,
  PresenceState,
} from "@meshbot/types";
import { IM_WS_EVENTS } from "@meshbot/types";
import { useAtomValue, useSetAtom } from "jotai";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { currentUserAtom } from "@/atoms/auth";
import {
  applyIncomingMessageAtom,
  currentConversationIdAtom,
  loadConversationsAtom,
  messagesAtom,
  removeConversationAtom,
  setPresenceAtom,
  upsertConversationAtom,
} from "@/atoms/im";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { ImConversationHeader } from "@/components/im/im-conversation-header";
import { ImMessageList } from "@/components/im/im-message-list";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { getImSocket } from "@/lib/im-socket";
import { fetchMessages } from "@/rest/im";
import { useMembers } from "@/rest/org";

function MessagesView() {
  const t = useTranslations("messages");
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const setCurrentConversationId = useSetAtom(currentConversationIdAtom);
  const loadConversations = useSetAtom(loadConversationsAtom);
  const applyIncomingMessage = useSetAtom(applyIncomingMessageAtom);
  const setPresence = useSetAtom(setPresenceAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);
  const removeConversation = useSetAtom(removeConversationAtom);
  const setMessages = useSetAtom(messagesAtom);
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);

  const oldestMessageIdRef = useRef<string | null>(null);
  const hasMoreHistoryRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [stickToBottom, setStickToBottom] = useState(true);
  const initialScrollDoneRef = useRef(false);

  // 1. URL hydration: sync ?id= → atom
  useEffect(() => {
    setCurrentConversationId(id);
  }, [id, setCurrentConversationId]);

  // 2. On mount: load conversations
  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // 3. Socket subscription (once on mount, not per-id)
  useEffect(() => {
    const socket = getImSocket();

    const onMessage = (payload: ImMessage) => {
      applyIncomingMessage(payload);
    };
    const onPresence = (payload: PresenceState) => {
      setPresence(payload);
    };
    const onConversationCreated = (payload: ConversationSummary) => {
      upsertConversation(payload);
    };
    const onConversationRemoved = (payload: { conversationId: string }) => {
      removeConversation(payload.conversationId);
    };

    socket.on(IM_WS_EVENTS.message, onMessage);
    socket.on(IM_WS_EVENTS.presence, onPresence);
    socket.on(IM_WS_EVENTS.conversationCreated, onConversationCreated);
    socket.on(IM_WS_EVENTS.conversationRemoved, onConversationRemoved);

    return () => {
      socket.off(IM_WS_EVENTS.message, onMessage);
      socket.off(IM_WS_EVENTS.presence, onPresence);
      socket.off(IM_WS_EVENTS.conversationCreated, onConversationCreated);
      socket.off(IM_WS_EVENTS.conversationRemoved, onConversationRemoved);
    };
  }, [
    applyIncomingMessage,
    setPresence,
    upsertConversation,
    removeConversation,
  ]);

  // 4. Load history when conversation id changes
  useEffect(() => {
    if (!id) {
      setMessages([]);
      return;
    }

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

    // Mark as read
    const socket = getImSocket();
    socket.emit(IM_WS_EVENTS.read, { conversationId: id });

    return () => {
      cancelled = true;
    };
  }, [id, setMessages]);

  // 5. History pagination: top-sentinel IntersectionObserver
  const loadMoreHistory = useCallback(async () => {
    if (!id) return;
    if (!hasMoreHistoryRef.current) return;
    if (loadingMoreRef.current) return;
    const cursor = oldestMessageIdRef.current;
    if (!cursor) return;

    loadingMoreRef.current = true;
    const scroller = scrollContainerRef.current;
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
  }, [id, setMessages]);

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
      if (!id) return;
      const socket = getImSocket();
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
    const root = scrollContainerRef.current;
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
  }, []);

  return (
    <AppShellLayout
      scrollContainerRef={scrollContainerRef}
      header={id ? <ImConversationHeader /> : undefined}
    >
      {!id ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("emptyHint")}
        </div>
      ) : (
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
      )}

      {id && (
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
      )}
    </AppShellLayout>
  );
}

/** /messages 页。useSearchParams 需 Suspense 边界（静态导出要求）。 */
export default function MessagesPage() {
  return (
    <Suspense fallback={null}>
      <MessagesView />
    </Suspense>
  );
}
