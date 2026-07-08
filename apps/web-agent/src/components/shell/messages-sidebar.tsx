"use client";

import { cn } from "@meshbot/design";
import {
  type NavGroup,
  type NavNode,
  SidebarHeader,
  SidebarNav,
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
 *
 * 数据来源（conversationsAtom 订阅 / 未读计算 / 在线态）全部留在本组件，只把
 * 分组 + 行渲染交给 SidebarNav：两组 NavNode[] 由 dms/channels 派生，未读 badge
 * 通过 renderTrailing 按 node.key（即会话 id）从会话 map 查值渲染；在线圆点是
 * 行首图标（与原 SidebarNavItem.icon 语义一致，SidebarRow 的 icon 插槽本就支持
 * “在线圆点”这类非 svg 内容），沿用原位置渲染以保证视觉不变。
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

  const loading = sessionsStatus === "idle" || sessionsStatus === "loading";

  const channels = conversations.filter((c) => c.type === "channel");
  const dms = conversations.filter((c) => c.type === "dm");

  // 会话 id → 会话对象，供 renderTrailing 按 node.key 查未读数。
  const conversationById = new Map(conversations.map((c) => [c.id, c]));

  const dmNodes: NavNode[] = dms.map((c) => {
    const peerId = c.peer?.userId ?? "";
    const online = peerId !== "" && (presence[peerId] ?? false);
    return {
      key: c.id,
      label: c.peer?.displayName ?? "",
      icon: (
        <span
          className={cn(
            "h-2.5 w-2.5 shrink-0 rounded-full",
            online ? "bg-green-400" : "bg-(--shell-sidebar-fg)/30",
          )}
        />
      ),
    };
  });

  const channelNodes: NavNode[] = channels.map((c) => ({
    key: c.id,
    label: c.name,
    icon:
      c.visibility === "private" ? (
        <Lock className="opacity-70" />
      ) : (
        <Hash className="opacity-70" />
      ),
  }));

  const groups: NavGroup[] = [
    {
      key: "dms",
      title: t("directMessages"),
      collapsible: true,
      items: dmNodes,
    },
    {
      key: "channels",
      title: t("channels"),
      collapsible: true,
      items: channelNodes,
    },
  ];

  // 只在 /messages 页面高亮当前会话，对齐原 `pathname === "/messages" && c.id === currentConvId`。
  const activeKey =
    pathname === "/messages" ? (currentConvId ?? undefined) : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <SidebarHeader
        title={t("title")}
        action={
          <button
            type="button"
            title={t("newMessage")}
            onClick={() => router.push("/messages/new")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
          >
            <SquarePen className="h-4 w-4" />
          </button>
        }
      />

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        <SidebarNav
          loading={loading}
          groups={groups}
          activeKey={activeKey}
          onSelect={(node) => router.push(`/messages?id=${node.key}`)}
          renderTrailing={(node) => {
            const conv = conversationById.get(node.key);
            if (!conv || conv.unreadCount <= 0) return undefined;
            return (
              <span className="shrink-0 rounded-full bg-(--shell-accent) px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
              </span>
            );
          }}
        />
      </div>
    </div>
  );
}
