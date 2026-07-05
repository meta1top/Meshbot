"use client";

import { cn } from "@meshbot/design";
import {
  SidebarNavItem,
  SidebarSection,
  SidebarSkeleton,
} from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { Hash, Lock, SquarePen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  conversationsAtom,
  currentConversationIdAtom,
  presenceAtom,
} from "@/atoms/im";
import { sessionsStatusAtom } from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";

/**
 * 统一消息侧栏：私信 / 频道两段，均来自 IM atom。助手已迁至独立 `/assistant` 区，
 * 不在此侧栏出现。点击私信/频道→/messages?id=；助手→/assistant?id=。
 */
export function MessagesSidebar() {
  const t = useTranslations("messagesSidebar");
  const router = useRouter();
  const pathname = usePathname();

  const conversations = useAtomValue(conversationsAtom);
  const currentConvId = useAtomValue(currentConversationIdAtom);
  const presence = useAtomValue(presenceAtom);

  const sessionsStatus = useAtomValue(sessionsStatusAtom);

  const loadSidebar = useSetAtom(loadSidebarAtom);

  // 单请求聚合加载（/api/sidebar）：loadSidebar 自带 guard——已加载则直接复用全局
  // atom 数据，跨路由切换侧栏重挂时不重复请求、不再闪骨架；骨架只首屏出现一次。
  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  const channels = conversations.filter((c) => c.type === "channel");
  const dms = conversations.filter((c) => c.type === "dm");

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-13 shrink-0 items-center justify-between border-b border-(--shell-sidebar-border) px-3.5">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
        <button
          type="button"
          title={t("newMessage")}
          onClick={() => router.push("/messages/new")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {sessionsStatus === "idle" || sessionsStatus === "loading" ? (
          <SidebarSkeleton />
        ) : (
          <>
            {/* 私信 */}
            <SidebarSection title={t("directMessages")}>
              {dms.map((c) => {
                const active =
                  pathname === "/messages" && c.id === currentConvId;
                const peerId = c.peer?.userId ?? "";
                const online = peerId !== "" && (presence[peerId] ?? false);
                return (
                  <SidebarNavItem
                    key={c.id}
                    active={active}
                    onClick={() => router.push(`/messages?id=${c.id}`)}
                    icon={
                      <span
                        className={cn(
                          "h-2.5 w-2.5 shrink-0 rounded-full",
                          online
                            ? "bg-green-400"
                            : "bg-(--shell-sidebar-fg)/30",
                        )}
                      />
                    }
                    label={c.peer?.displayName ?? ""}
                    trailing={
                      c.unreadCount > 0 ? (
                        <span className="shrink-0 rounded-full bg-(--shell-accent) px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                          {c.unreadCount > 99 ? "99+" : c.unreadCount}
                        </span>
                      ) : undefined
                    }
                  />
                );
              })}
            </SidebarSection>

            {/* 频道 */}
            <SidebarSection title={t("channels")}>
              {channels.map((c) => {
                const active =
                  pathname === "/messages" && c.id === currentConvId;
                return (
                  <SidebarNavItem
                    key={c.id}
                    active={active}
                    onClick={() => router.push(`/messages?id=${c.id}`)}
                    icon={
                      c.visibility === "private" ? (
                        <Lock className="opacity-70" />
                      ) : (
                        <Hash className="opacity-70" />
                      )
                    }
                    label={c.name}
                    trailing={
                      c.unreadCount > 0 ? (
                        <span className="shrink-0 rounded-full bg-(--shell-accent) px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                          {c.unreadCount > 99 ? "99+" : c.unreadCount}
                        </span>
                      ) : undefined
                    }
                  />
                );
              })}
            </SidebarSection>
          </>
        )}
      </div>
    </div>
  );
}
