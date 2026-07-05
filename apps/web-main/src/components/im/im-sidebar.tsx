"use client";

import { cn } from "@meshbot/design";
import type { ConversationSummary } from "@meshbot/types";
import {
  SidebarNavItem,
  SidebarSection,
  SidebarSkeleton,
} from "@meshbot/web-common/shell";
import { SquarePen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useDeviceOnline, useDevicePresenceSync } from "@/rest/agent-devices";
import { useConversations } from "@/rest/im";
import { AgentPicker } from "./agent-picker";

/**
 * IM 侧栏（web-main）：顶部「新建会话」开 Agent picker，下面列出与各设备 Agent 的
 * 私信会话（`agentDeviceId != null`），会话名取设备名（`peer.displayName`），左侧在线点。
 * 在线点首屏取 `useDeviceOnline` 快照，实时变化由 `useDevicePresenceSync` 订阅
 * `ws/im` 的 presence 事件推送更新。
 */
export function ImSidebar() {
  const t = useTranslations("messagesSidebar");
  const router = useRouter();
  const { data: conversations = [], isPending, error } = useConversations();
  const [pickerOpen, setPickerOpen] = useState(false);

  useDevicePresenceSync();

  const agentDms = conversations.filter((c) => c.agentDeviceId != null);

  return (
    <div className="flex h-full w-64 shrink-0 flex-col overflow-hidden rounded-l-(--shell-radius) bg-(--shell-sidebar) text-(--shell-sidebar-fg)">
      <div className="flex h-13 shrink-0 items-center justify-between border-b border-(--shell-sidebar-border) px-3.5">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
        <button
          type="button"
          title={t("newDm")}
          onClick={() => setPickerOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {error ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/60">
            {t("loadFailed")}
          </div>
        ) : isPending ? (
          <SidebarSkeleton />
        ) : (
          <SidebarSection title={t("agentDms")}>
            {agentDms.length === 0 ? (
              <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/60">
                {t("empty")}
              </div>
            ) : (
              agentDms.map((c) => (
                <AgentDmItem
                  key={c.id}
                  conversation={c}
                  onClick={() => router.push(`/messages/${c.id}`)}
                />
              ))
            )}
          </SidebarSection>
        )}
      </div>

      <AgentPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  );
}

interface AgentDmItemProps {
  conversation: ConversationSummary;
  onClick: () => void;
}

/**
 * 单个 Agent-DM 会话项：在线点 + 设备名 + 未读 badge。在线态取首屏快照
 * （`useDeviceOnline`），实时变化由 `useDevicePresenceSync` 写入的 presence 缓存驱动。
 */
function AgentDmItem({ conversation, onClick }: AgentDmItemProps) {
  const t = useTranslations("messagesSidebar");
  const pathname = usePathname();
  const deviceId = conversation.agentDeviceId ?? "";
  const { data } = useDeviceOnline(deviceId);
  const online = data?.online ?? false;
  const active = pathname === `/messages/${conversation.id}`;
  const name = conversation.peer?.displayName ?? "";

  return (
    <SidebarNavItem
      active={active}
      onClick={onClick}
      icon={
        <span
          title={online ? t("online") : t("offline")}
          className={cn(
            "h-2.5 w-2.5 shrink-0 rounded-full",
            online ? "bg-green-400" : "bg-(--shell-sidebar-fg)/30",
          )}
        />
      }
      label={name}
      trailing={
        conversation.unreadCount > 0 ? (
          <span className="shrink-0 rounded-full bg-(--shell-accent) px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
            {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
          </span>
        ) : undefined
      }
    />
  );
}
