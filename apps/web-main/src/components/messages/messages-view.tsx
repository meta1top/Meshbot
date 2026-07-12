"use client";

import { cn, Skeleton } from "@meshbot/design";
import type {
  ChannelMember,
  ConversationSummary,
  ImMessage,
} from "@meshbot/types";
import {
  ChannelPicker,
  ConversationHeader,
  type ConversationHeaderLabels,
  ConversationList,
  type ConversationListLabels,
  type CreateChannelInput,
  DmPicker,
  MessageFlow,
  MessageInput,
} from "@meshbot/web-common/im";
import { PageShellView } from "@meshbot/web-common/shell";
import { Hash, MessageSquare, User, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSidebarSlot } from "@/components/shell/sidebar-slot-context";
import { createMainImTransport } from "@/lib/im-transport";
import { useProfile } from "@/rest/auth";
import { useMembers } from "@/rest/org";

/** 会话按 id upsert：已存在则原地替换，否则插到最前。 */
function upsertConversation(
  list: ConversationSummary[],
  next: ConversationSummary,
): ConversationSummary[] {
  const idx = list.findIndex((c) => c.id === next.id);
  if (idx === -1) return [next, ...list];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

/** 收到一条实时消息：刷新该会话的 lastMessage；非当前打开、非自己发的才计未读。 */
function applyIncomingMessage(
  list: ConversationSummary[],
  message: ImMessage,
  meUserId: string,
  openConversationId: string | null,
): ConversationSummary[] {
  return list.map((c) => {
    if (c.id !== message.conversationId) return c;
    const isOpen = c.id === openConversationId;
    const isSelf = message.senderId === meUserId;
    return {
      ...c,
      lastMessage: {
        content: message.content,
        senderId: message.senderId,
        createdAt: message.createdAt,
      },
      unreadCount: isOpen || isSelf ? c.unreadCount : c.unreadCount + 1,
    };
  });
}

/** 消息历史首载骨架：贴近真实消息行形状（头像方块 + 变宽文字条）。 */
function MessageHistorySkeleton() {
  const rowWidths = ["w-[72%]", "w-[55%]", "w-[63%]", "w-[40%]", "w-[66%]"];
  return (
    <div className="flex w-full flex-1 flex-col gap-4 py-2" aria-hidden>
      {rowWidths.map((width) => (
        <div key={width} className="flex gap-3">
          <Skeleton className="mt-0.5 h-7 w-7 shrink-0 rounded-[6px]" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-10" />
            </div>
            <Skeleton className={cn("h-3", width)} />
          </div>
        </div>
      ))}
    </div>
  );
}

interface ConversationSublistProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  presence: Record<string, boolean>;
  loading: boolean;
  onSelect: (conversationId: string) => void;
  onNewMessage: () => void;
  labels: ConversationListLabels;
}

/** 二级子栏：会话列表，portal 进 WorkspaceSidebar 的子栏插槽。 */
function ConversationSublist({
  conversations,
  activeId,
  presence,
  loading,
  onSelect,
  onNewMessage,
  labels,
}: ConversationSublistProps) {
  const slot = useSidebarSlot();
  if (!slot) return null;
  return createPortal(
    <ConversationList
      conversations={conversations}
      activeId={activeId}
      presence={presence}
      loading={loading}
      onSelect={onSelect}
      onNewMessage={onNewMessage}
      labels={labels}
    />,
    slot,
  );
}

interface NewMessageChooserLabels {
  title: string;
  channelAction: string;
  dmAction: string;
}

/** 「+新消息」的第一步选择：新建频道 / 发起私信。web-main 无 web-agent 式收件人搜索框，
 * 用最简单的两项选择弹框，选定后交给对应的 web-common Picker 组件。 */
function NewMessageChooser({
  onPickChannel,
  onPickDm,
  onClose,
  labels,
}: {
  onPickChannel: () => void;
  onPickDm: () => void;
  onClose: () => void;
  labels: NewMessageChooserLabels;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="dialog"
      aria-modal
      aria-label={labels.title}
    >
      <div className="w-72 rounded-xl bg-(--shell-content) shadow-2xl ring-1 ring-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[14px] font-semibold text-foreground">
            {labels.title}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-1 p-2">
          <button
            type="button"
            onClick={onPickChannel}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13.5px] text-foreground transition-colors hover:bg-muted"
          >
            <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
            {labels.channelAction}
          </button>
          <button
            type="button"
            onClick={onPickDm}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13.5px] text-foreground transition-colors hover:bg-muted"
          >
            <User className="h-4 w-4 shrink-0 text-muted-foreground" />
            {labels.dmAction}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * `/messages` 页装配：二级子栏会话列表（portal）+ 主区会话头/消息流/输入框。
 * 唯一数据入口是 `createMainImTransport()`（REST 首屏 + WS 增量），本组件只做
 * 状态编排与 labels 注入，不直接碰 REST/socket。
 */
export function MessagesView() {
  const t = useTranslations("messages");
  const tSidebar = useTranslations("messagesSidebar");
  const tConv = useTranslations("imConversation");
  const tChat = useTranslations("chatInput");

  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(() => createMainImTransport(), []);
  const { data: profile } = useProfile();
  const meUserId = profile?.user?.id ?? "";
  const orgId = profile?.activeOrg?.id ?? null;

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [presence, setPresence] = useState<Record<string, boolean>>({});

  const [messages, setMessages] = useState<ImMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const oldestIdRef = useRef<string | null>(null);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const currentIdRef = useRef<string | null>(null);

  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [newMessageMode, setNewMessageMode] = useState<
    "choose" | "channel" | "dm" | null
  >(null);

  const currentConversation = conversations.find((c) => c.id === id) ?? null;
  const isPrivateChannel =
    !!currentConversation &&
    currentConversation.type === "channel" &&
    currentConversation.visibility === "private";

  // 首屏拉取会话列表（一次）。
  useEffect(() => {
    let cancelled = false;
    setConversationsLoading(true);
    void transport
      .listConversations()
      .then((list) => {
        if (!cancelled) setConversations(list);
      })
      .finally(() => {
        if (!cancelled) setConversationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [transport]);

  // 追踪当前会话 id（供下面稳定订阅的闭包读取最新值，避免每次切换会话都重新订阅）。
  useEffect(() => {
    currentIdRef.current = id;
  }, [id]);

  // 订阅实时事件（稳定订阅一次）+ presence 初始快照。
  useEffect(() => {
    setPresence(Object.fromEntries(transport.presenceSnapshot()));
    return transport.subscribe({
      onMessage: (m) => {
        setConversations((prev) =>
          applyIncomingMessage(prev, m, meUserId, currentIdRef.current),
        );
        if (m.conversationId === currentIdRef.current) {
          setMessages((prev) => [...prev, m]);
        }
      },
      onPresence: (p) => {
        setPresence((prev) => ({ ...prev, [p.userId]: p.online }));
      },
      onConversationCreated: (c) => {
        setConversations((prev) => upsertConversation(prev, c));
      },
      onConversationRemoved: (conversationId) => {
        setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      },
      onConversationRead: (e) => {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === e.conversationId ? { ...c, unreadCount: 0 } : c,
          ),
        );
      },
    });
  }, [transport, meUserId]);

  // 切换会话：拉历史 + 标记已读。
  useEffect(() => {
    if (!id) {
      setMessages([]);
      setHistoryLoading(false);
      setHistoryError(false);
      return;
    }
    let cancelled = false;
    setMessages([]);
    setHistoryLoading(true);
    setHistoryError(false);
    oldestIdRef.current = null;
    hasMoreRef.current = true;
    setHasMore(true);

    void transport
      .listMessages(id)
      .then((page) => {
        if (cancelled) return;
        setMessages(page.messages);
        oldestIdRef.current = page.messages[0]?.id ?? null;
        hasMoreRef.current = page.hasMore;
        setHasMore(page.hasMore);
      })
      .catch(() => {
        if (!cancelled) setHistoryError(true);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });

    void transport.markRead(id);
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)),
    );

    return () => {
      cancelled = true;
    };
  }, [id, transport]);

  const loadMoreHistory = useCallback(async () => {
    if (!id) return;
    if (!hasMoreRef.current || loadingMoreRef.current) return;
    const cursor = oldestIdRef.current;
    if (!cursor) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    const scroller = scrollRef.current;
    const prevScrollHeight = scroller?.scrollHeight ?? 0;
    const prevScrollTop = scroller?.scrollTop ?? 0;

    try {
      const page = await transport.listMessages(id, { before: cursor });
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const fresh = page.messages.filter((m) => !existingIds.has(m.id));
        return [...fresh, ...prev];
      });
      oldestIdRef.current = page.messages[0]?.id ?? cursor;
      hasMoreRef.current = page.hasMore;
      setHasMore(page.hasMore);

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
      setLoadingMore(false);
    }
  }, [id, transport]);

  const handleSend = useCallback(
    (text: string) => {
      if (!id) return;
      void transport.send(id, text);
    },
    [id, transport],
  );

  const loadMembers = useCallback(async () => {
    if (!currentConversation || !isPrivateChannel) return;
    try {
      setMembers(await transport.listChannelMembers(currentConversation.id));
    } catch {
      // 静默失败，保留上次结果
    }
  }, [currentConversation, isPrivateChannel, transport]);

  useEffect(() => {
    if (!isPrivateChannel) {
      setMembers([]);
      return;
    }
    void loadMembers();
  }, [isPrivateChannel, loadMembers]);

  // 无条件拉取（不按弹层开关惰性加载）：既做 Picker/添加成员候选人，也是消息流
  // senderId → 展示名解析的权威来源（频道消息可能来自任意 org 成员，不能只在
  // 弹层打开时才知道名字）。react-query 按 queryKey 去重，不会因多处调用而多发请求。
  const { data: candidateMembers = [], isLoading: candidatesLoading } =
    useMembers(orgId);
  const candidates = candidateMembers.filter((m) => m.userId !== meUserId);

  const handleAddMember = useCallback(
    async (userId: string) => {
      if (!currentConversation) return;
      await transport.addChannelMember(currentConversation.id, userId);
      await loadMembers();
    },
    [currentConversation, loadMembers, transport],
  );

  const handleLeave = useCallback(async () => {
    if (!currentConversation) return;
    const leftId = currentConversation.id;
    await transport.leaveChannel(leftId);
    setConversations((prev) => prev.filter((c) => c.id !== leftId));
    router.push("/messages");
  }, [currentConversation, router, transport]);

  const handleCreateChannel = useCallback(
    async (input: CreateChannelInput) => {
      const conv = await transport.createChannel(
        input.name,
        input.memberIds ?? [],
        input.visibility,
      );
      setConversations((prev) => upsertConversation(prev, conv));
      router.push(`/messages?id=${conv.id}`);
    },
    [router, transport],
  );

  const handlePickDm = useCallback(
    async (userId: string) => {
      const conv = await transport.createDm(userId);
      setConversations((prev) => upsertConversation(prev, conv));
      router.push(`/messages?id=${conv.id}`);
    },
    [router, transport],
  );

  // senderId → 展示名：自己 + org 成员 + 当前 DM 对端（org 成员列表可能不含对端，
  // 例如个人账号 orgId 为空 / 成员列表尚未加载），与 web-agent 同款兜底顺序。
  const memberMap = useMemo(() => {
    const map: Record<string, { displayName: string }> = {};
    if (profile?.user) {
      map[profile.user.id] = { displayName: profile.user.displayName };
    }
    for (const m of candidateMembers) {
      map[m.userId] = { displayName: m.displayName };
    }
    if (currentConversation?.peer) {
      map[currentConversation.peer.userId] = {
        displayName: currentConversation.peer.displayName,
      };
    }
    return map;
  }, [profile?.user, candidateMembers, currentConversation]);
  const resolveDisplayName = useCallback(
    (senderId: string) => memberMap[senderId]?.displayName ?? senderId,
    [memberMap],
  );

  const conversationListLabels: ConversationListLabels = {
    title: tSidebar("title"),
    newMessage: tSidebar("newMessage"),
    channels: tSidebar("channels"),
    directMessages: tSidebar("directMessages"),
  };

  const conversationHeaderLabels: ConversationHeaderLabels = {
    online: t("online"),
    privateChannelMembers: t("privateChannelMembers"),
    privateChannelAddMember: t("privateChannelAddMember"),
    privateChannelNoMoreMembers: t("privateChannelNoMoreMembers"),
    privateChannelLeave: t("privateChannelLeave"),
    privateChannelLeaving: t("privateChannelLeaving"),
    privateChannelLeaveConfirm: (name) =>
      t("privateChannelLeaveConfirm", { name }),
    channelCancel: t("channelCancel"),
    loading: t("loading"),
  };

  return (
    <>
      <ConversationSublist
        conversations={conversations}
        activeId={id}
        presence={presence}
        loading={conversationsLoading}
        onSelect={(conversationId) =>
          router.push(`/messages?id=${conversationId}`)
        }
        onNewMessage={() => setNewMessageMode("choose")}
        labels={conversationListLabels}
      />

      <PageShellView
        scrollContainerRef={scrollRef}
        header={
          id ? (
            <ConversationHeader
              conversation={currentConversation}
              members={members}
              memberCandidates={candidates}
              memberCandidatesLoading={candidatesLoading}
              presence={presence}
              onAddMember={handleAddMember}
              onLeave={handleLeave}
              labels={conversationHeaderLabels}
            />
          ) : undefined
        }
      >
        {id ? (
          <>
            <div className="flex w-full flex-1 flex-col">
              {historyLoading ? (
                <MessageHistorySkeleton />
              ) : historyError ? (
                <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
                  {tConv("historyError")}
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                  <div className="text-[14px] font-semibold text-foreground">
                    {tConv("emptyTitle")}
                  </div>
                  <div className="max-w-[280px] text-[13px] text-muted-foreground">
                    {tConv("emptyDescription")}
                  </div>
                </div>
              ) : (
                <MessageFlow
                  messages={messages}
                  meUserId={meUserId}
                  hasMore={hasMore}
                  loadingMore={loadingMore}
                  onLoadMore={() => void loadMoreHistory()}
                  scrollRef={scrollRef}
                  resolveDisplayName={resolveDisplayName}
                  renderContent={(m) => (
                    <p className="whitespace-pre-wrap break-words text-[13px] text-foreground">
                      {m.content}
                    </p>
                  )}
                  labels={{
                    today: tConv("today"),
                    yesterday: tConv("yesterday"),
                    copy: tConv("copy"),
                  }}
                />
              )}
            </div>

            <div className="sticky bottom-0 mt-auto w-full bg-(--shell-content) pt-2">
              <MessageInput
                onSend={handleSend}
                placeholder={t("inputPlaceholder")}
                labels={{
                  attachment: tChat("attachment"),
                  send: tChat("send"),
                }}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
              <MessageSquare className="h-7 w-7" />
            </span>
            <div className="text-[15px] font-semibold text-foreground">
              {t("empty.title")}
            </div>
            <div className="max-w-[320px] text-[13px] text-muted-foreground">
              {t("empty.description")}
            </div>
          </div>
        )}
      </PageShellView>

      {newMessageMode === "choose" && (
        <NewMessageChooser
          onPickChannel={() => setNewMessageMode("channel")}
          onPickDm={() => setNewMessageMode("dm")}
          onClose={() => setNewMessageMode(null)}
          labels={{
            title: tSidebar("newMessage"),
            channelAction: t("newChannel"),
            dmAction: t("newDm"),
          }}
        />
      )}
      {newMessageMode === "channel" && (
        <ChannelPicker
          candidates={candidates}
          loading={candidatesLoading}
          onCreate={handleCreateChannel}
          onClose={() => setNewMessageMode(null)}
          labels={{
            title: t("newChannel"),
            nameLabel: t("channelNameLabel"),
            namePlaceholder: t("channelNamePlaceholder"),
            visibilityLabel: t("channelVisibilityLabel"),
            visibilityPublic: t("channelVisibilityPublic"),
            visibilityPrivate: t("channelVisibilityPrivate"),
            initialMembers: t("channelInitialMembers"),
            noMembers: t("channelNoMembers"),
            loading: t("loading"),
            cancel: t("channelCancel"),
            create: t("channelCreate"),
            creating: t("channelCreating"),
          }}
        />
      )}
      {newMessageMode === "dm" && (
        <DmPicker
          candidates={candidates}
          loading={candidatesLoading}
          onPick={handlePickDm}
          onClose={() => setNewMessageMode(null)}
          labels={{
            title: t("pickMember"),
            loading: t("loading"),
            empty: t("dmEmpty"),
          }}
        />
      )}
    </>
  );
}
