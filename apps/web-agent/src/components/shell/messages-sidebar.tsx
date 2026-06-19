"use client";

import { cn } from "@meshbot/design";
import { useAtomValue, useSetAtom } from "jotai";
import { Clock, Hash, Lock, SquarePen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  conversationsAtom,
  currentConversationIdAtom,
  loadConversationsAtom,
  presenceAtom,
} from "@/atoms/im";
import {
  loadSessionsAtom,
  pinnedSessionsAtom,
  recentSessionsAtom,
  sessionsStatusAtom,
} from "@/atoms/sessions";
import { SidebarSection } from "@/components/shell/sidebar-section";
import { SessionListItem } from "@/components/sidebar/session-list-item";

/**
 * 统一消息侧栏：频道 / 私信 / 助手三段。频道+私信来自 IM atom，
 * 助手来自 session atom。点击频道/私信→/messages?id=，助手→/session?id=。
 */
export function MessagesSidebar() {
  const t = useTranslations("messagesSidebar");
  const router = useRouter();
  const pathname = usePathname();

  const conversations = useAtomValue(conversationsAtom);
  const currentConvId = useAtomValue(currentConversationIdAtom);
  const presence = useAtomValue(presenceAtom);
  const loadConversations = useSetAtom(loadConversationsAtom);

  const pinned = useAtomValue(pinnedSessionsAtom);
  const recent = useAtomValue(recentSessionsAtom);
  const sessionsStatus = useAtomValue(sessionsStatusAtom);
  const loadSessions = useSetAtom(loadSessionsAtom);

  useEffect(() => {
    void loadConversations();
    void loadSessions();
  }, [loadConversations, loadSessions]);

  const channels = conversations.filter((c) => c.type === "channel");
  const dms = conversations.filter((c) => c.type === "dm");
  const assistantSessions = [...pinned, ...recent];

  const rowBase =
    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors";

  return (
    <div className="flex h-full flex-col bg-(--shell-sidebar) text-white">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/15 px-3.5">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
        <button
          type="button"
          title={t("newMessage")}
          onClick={() => router.push("/messages/new")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {/* 频道 */}
        <SidebarSection title={t("channels")}>
          {channels.map((c) => {
            const active = pathname === "/messages" && c.id === currentConvId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => router.push(`/messages?id=${c.id}`)}
                className={cn(
                  rowBase,
                  active
                    ? "bg-(--shell-accent) text-white"
                    : "text-white/80 hover:bg-white/12",
                )}
              >
                {c.visibility === "private" ? (
                  <Lock className="h-3.5 w-3.5 shrink-0 opacity-70" />
                ) : (
                  <Hash className="h-3.5 w-3.5 shrink-0 opacity-70" />
                )}
                <span className="min-w-0 flex-1 truncate text-left">
                  {c.name}
                </span>
                {c.unreadCount > 0 && (
                  <span className="shrink-0 rounded-full bg-(--shell-accent) px-1.5 py-0.5 text-[10px] font-bold leading-none">
                    {c.unreadCount > 99 ? "99+" : c.unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </SidebarSection>

        {/* 私信 */}
        <SidebarSection title={t("directMessages")}>
          {dms.map((c) => {
            const active = pathname === "/messages" && c.id === currentConvId;
            const peerId = c.peer?.userId ?? "";
            const online = peerId !== "" && (presence[peerId] ?? false);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => router.push(`/messages?id=${c.id}`)}
                className={cn(
                  rowBase,
                  active
                    ? "bg-(--shell-accent) text-white"
                    : "text-white/80 hover:bg-white/12",
                )}
              >
                <span
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 rounded-full",
                    online ? "bg-green-400" : "bg-white/30",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-left">
                  {c.peer?.displayName ?? ""}
                </span>
                {c.unreadCount > 0 && (
                  <span className="shrink-0 rounded-full bg-(--shell-accent) px-1.5 py-0.5 text-[10px] font-bold leading-none">
                    {c.unreadCount > 99 ? "99+" : c.unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </SidebarSection>

        {/* 助手 */}
        <SidebarSection title={t("assistant")}>
          {sessionsStatus === "error" ? (
            <div className="px-2 py-1 text-[12px] text-white/55">
              {t("loadFailed")}
            </div>
          ) : assistantSessions.length === 0 && sessionsStatus === "loaded" ? (
            <div className="px-2 py-1 text-[12px] text-white/55">
              {t("assistantEmpty")}
            </div>
          ) : (
            assistantSessions.map((s) => (
              <SessionListItem key={s.id} session={s} />
            ))
          )}
        </SidebarSection>
      </div>

      {/* 助手区底部：定时任务入口 */}
      <button
        type="button"
        onClick={() => router.push("/schedule")}
        className={cn(
          "mx-2 mt-1 mb-2.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
          pathname.startsWith("/schedule")
            ? "bg-(--shell-accent) text-white"
            : "text-white/75 hover:bg-white/12",
        )}
      >
        <Clock className="h-4 w-4" />
        {t("scheduled")}
      </button>
    </div>
  );
}
