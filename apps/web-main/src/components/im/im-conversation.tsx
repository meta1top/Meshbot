"use client";

import { IM_WS_EVENTS, type ImMessage } from "@meshbot/types";
import { AlertCircle, Loader2, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImMessageList } from "@/components/im/im-message-list";
import { getImSocket } from "@/lib/im-socket";
import { fetchMessages, useConversations } from "@/rest/im";

interface ImConversationProps {
  conversationId: string;
}

/**
 * 按 id 去重合并两组消息，结果按 createdAt 升序（同刻以雪花 id 为次序稳定 tiebreak）。
 * 初次加载与向上翻页共用：既能把 REST 历史与已累积的实时消息合并去重，也能保证
 * 「mount 后、REST 返回前经 ws 到达的实时消息」不被历史快照无条件覆盖抹掉。
 */
function mergeById(a: ImMessage[], b: ImMessage[]): ImMessage[] {
  const map = new Map<string, ImMessage>();
  for (const m of a) map.set(m.id, m);
  for (const m of b) map.set(m.id, m);
  return [...map.values()].sort((x, y) => {
    if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}

/**
 * Agent-DM 会话主体（web-main 直连 server-main `/ws/im`，非信封总线）：
 * 打开时拉历史 + 标记已读，订阅原生 `IM_WS_EVENTS.message` 事件按 conversationId 过滤追加，
 * 发送走 `IM_WS_EVENTS.send`（无乐观插入，靠服务端广播回声上屏），
 * 向上滚动到顶部 sentinel 触发游标分页并锚定滚动位置。
 */
export function ImConversation({ conversationId }: ImConversationProps) {
  const t = useTranslations("imConversation");
  const tInput = useTranslations("chatInput");

  const { data: conversations } = useConversations();
  const conversation = useMemo(
    () => conversations?.find((c) => c.id === conversationId) ?? null,
    [conversations, conversationId],
  );
  const agentName = conversation?.peer?.displayName ?? t("agentFallback");
  const agentInitial = agentName.trim().charAt(0).toUpperCase() || "A";

  const [messages, setMessages] = useState<ImMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState("");

  const oldestMessageIdRef = useRef<string | null>(null);
  const hasMoreHistoryRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const initialScrollDoneRef = useRef(false);
  const [stickToBottom, setStickToBottom] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 1. 切换会话：重置本地状态 + 拉首屏历史 + 标记已读
  useEffect(() => {
    setMessages([]);
    setHistoryLoading(true);
    setHistoryError(false);
    oldestMessageIdRef.current = null;
    hasMoreHistoryRef.current = true;
    setHasMoreHistory(true);
    initialScrollDoneRef.current = false;

    let cancelled = false;

    void fetchMessages(conversationId)
      .then((page) => {
        if (cancelled) return;
        // 合并而非覆盖：保留 mount 后、本次 REST 返回前经 ws 实时到达的消息，
        // 避免「点通知打开会话恰逢回复落地」时回复闪现后被历史快照抹掉。
        setMessages((prev) => mergeById(page.messages, prev));
        oldestMessageIdRef.current = page.messages[0]?.id ?? null;
        hasMoreHistoryRef.current = page.hasMore;
        setHasMoreHistory(page.hasMore);
      })
      .catch(() => {
        if (!cancelled) setHistoryError(true);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });

    const socket = getImSocket();
    socket.emit(IM_WS_EVENTS.read, { conversationId });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // 2. 订阅实时新消息：按 conversationId 过滤后追加（去重防止回声重复插入）
  useEffect(() => {
    const socket = getImSocket();
    const onMessage = (msg: ImMessage) => {
      if (msg.conversationId !== conversationId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    };
    socket.on(IM_WS_EVENTS.message, onMessage);
    return () => {
      socket.off(IM_WS_EVENTS.message, onMessage);
    };
  }, [conversationId]);

  // 3. 历史分页：加载更早消息 + 锚定滚动位置（prepend 后视口内容不跳动）
  const loadMoreHistory = useCallback(async () => {
    if (!hasMoreHistoryRef.current || loadingMoreRef.current) return;
    const cursor = oldestMessageIdRef.current;
    if (!cursor) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    const scroller = scrollRef.current;
    const prevScrollHeight = scroller?.scrollHeight ?? 0;
    const prevScrollTop = scroller?.scrollTop ?? 0;

    try {
      const page = await fetchMessages(conversationId, cursor);
      setMessages((prev) => mergeById(page.messages, prev));
      oldestMessageIdRef.current = page.messages[0]?.id ?? cursor;
      hasMoreHistoryRef.current = page.hasMore;
      setHasMoreHistory(page.hasMore);

      requestAnimationFrame(() => {
        if (!scroller) return;
        const newScrollHeight = scroller.scrollHeight;
        scroller.scrollTop =
          prevScrollTop + (newScrollHeight - prevScrollHeight);
      });
    } catch {
      // 静默失败：sentinel 仍在视口内，用户再次滚动会重新触发
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [conversationId]);

  // 顶部 sentinel 的 IntersectionObserver。依赖显式带上 historyLoading：
  // 首屏 fetch 完成前 sentinel 不在 DOM 里，若不把 historyLoading 加入依赖，
  // effect 不会在 sentinel 挂载后重新绑定观察者（hasMoreHistory 在此期间可能没变化）。
  useEffect(() => {
    if (historyLoading || !hasMoreHistory) return;
    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMoreHistory();
      },
      { root, rootMargin: "100px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [loadMoreHistory, hasMoreHistory, historyLoading]);

  // 4. 粘底：新消息到达时若仍处于底部则跟随滚动；首次进入直接跳底（无动画）
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

  // 底部 sentinel：探测用户是否已离开底部（离开则暂停自动跟随）
  useEffect(() => {
    const sentinel = bottomRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const io = new IntersectionObserver(
      (entries) => setStickToBottom(entries[0]?.isIntersecting ?? false),
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  // 5. 发送：仅 emit，无乐观插入，靠服务端广播的 im.message 回声上屏
  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const socket = getImSocket();
    socket.emit(IM_WS_EVENTS.send, { conversationId, content: text });
    setDraft("");
  }, [draft, conversationId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return; // IME 组合期间不拦截 Enter
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-(--shell-accent) text-[12px] font-semibold text-white">
          {agentInitial}
        </div>
        <span className="truncate text-sm font-semibold text-foreground">
          {agentName}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {historyLoading ? (
          <div className="flex flex-col gap-3 py-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-10 w-2/3 animate-pulse rounded-2xl bg-muted"
              />
            ))}
          </div>
        ) : historyError ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground/50" />
            <div className="text-sm text-muted-foreground">
              {t("historyError")}
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-10 text-center">
            <div className="text-[14px] font-semibold text-foreground">
              {t("emptyTitle")}
            </div>
            <div className="max-w-sm text-sm text-muted-foreground">
              {t("emptyDescription", { agent: agentName })}
            </div>
          </div>
        ) : (
          <>
            {hasMoreHistory && (
              <div
                ref={topSentinelRef}
                className="flex justify-center py-2 text-xs text-muted-foreground/60"
              >
                {loadingMore && (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("loadingMore")}
                  </span>
                )}
              </div>
            )}
            <ImMessageList messages={messages} agentName={agentName} />
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={tInput("placeholder")}
            className="max-h-32 min-h-9 flex-1 resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!draft.trim()}
            title={tInput("send")}
            aria-label={tInput("send")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-(--shell-accent) text-white transition-opacity disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
