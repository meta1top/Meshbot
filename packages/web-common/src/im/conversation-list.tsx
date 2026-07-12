"use client";

import { cn } from "@meshbot/design";
import type { ConversationSummary } from "@meshbot/types";
import { Hash, Lock, SquarePen } from "lucide-react";
import { SidebarHeader } from "../shell/sidebar-header";
import { type NavGroup, type NavNode, SidebarNav } from "../shell/sidebar-nav";

export interface ConversationListLabels {
  /** 侧栏标题（如“消息”）。 */
  title: string;
  /** 新建会话按钮 title。 */
  newMessage: string;
  /** 频道分组标题。 */
  channels: string;
  /** 私信分组标题。 */
  directMessages: string;
}

export interface ConversationListProps {
  conversations: ConversationSummary[];
  /** 当前高亮会话 id；不在会话页上下文时传 null/undefined 不高亮任何行。 */
  activeId?: string | null;
  /** userId → 是否在线，驱动私信行的在线圆点。 */
  presence: Record<string, boolean>;
  /** 首屏聚合加载中：渲染骨架（委托 SidebarNav 内建骨架）。 */
  loading?: boolean;
  onSelect: (conversationId: string) => void;
  onNewMessage: () => void;
  labels: ConversationListLabels;
}

/**
 * 会话列表：私信 / 频道两段分组，私信行含在线圆点，两类行均含未读数 badge。
 * 纯展示 + 数据派生（按 type 分组、presence 查在线态、unreadCount 取 badge）；
 * 不含路由 / atom / i18n —— 由调用方注入 conversations/presence/activeId 与回调 + labels。
 */
export function ConversationList({
  conversations,
  activeId,
  presence,
  loading = false,
  onSelect,
  onNewMessage,
  labels,
}: ConversationListProps) {
  const dms = conversations.filter((c) => c.type === "dm");
  const channels = conversations.filter((c) => c.type === "channel");

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
      title: labels.directMessages,
      collapsible: true,
      items: dmNodes,
    },
    {
      key: "channels",
      title: labels.channels,
      collapsible: true,
      items: channelNodes,
    },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <SidebarHeader
        title={labels.title}
        action={
          <button
            type="button"
            title={labels.newMessage}
            onClick={onNewMessage}
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
          activeKey={activeId ?? undefined}
          onSelect={(node) => onSelect(node.key)}
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
