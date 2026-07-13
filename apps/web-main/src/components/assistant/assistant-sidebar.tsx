"use client";

import { cn } from "@meshbot/design";
import type { SessionSummary } from "@meshbot/types-agent";
import {
  type NavNode,
  SidebarHeader,
  SidebarNav,
  SidebarRow,
  type SidebarRowProps,
} from "@meshbot/web-common/shell";
import { useQueries } from "@tanstack/react-query";
import { Sparkles, SquarePen } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useSidebarSlot } from "@/components/shell/sidebar-slot-context";
import { remoteSessionsQueryKey } from "@/hooks/use-remote-sessions";
import { remoteQuery } from "@/lib/device-query";
import {
  deviceOnlineQueryKey,
  fetchDeviceOnline,
  useDevicePresenceSync,
} from "@/rest/agent-devices";
import { useDevices } from "@/rest/devices";

/**
 * 助手区侧栏：设备 → 会话两级展开树（对齐 web-agent `assistant-sidebar.tsx`）。
 *
 * 渲染进助手段的持久 layout（`(shell)/assistant/layout.tsx`），因此展开态
 * （`expanded` useState）与已加载会话（React Query 缓存）在 `/assistant` ↔
 * `/assistant/[deviceId]` 间导航时不丢——不像旧的「点设备跳独立页」会 remount。
 *
 * - 一级 = 该账号全部已授权设备（在线点 + 名称，离线置灰不可展开）；
 * - 展开在线设备 → 并入 `expanded` → `useQueries` 懒加载该设备会话内联铺开，
 *   多设备可同时展开；
 * - 点会话叶子 → `/assistant/[deviceId]?session=<id>` 打开主区；
 * - 设备行尾「新建」→ `/assistant/[deviceId]`（无 session 参数 = 新建态）。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const tDevices = useTranslations("devices");
  const router = useRouter();
  const slot = useSidebarSlot();
  const searchParams = useSearchParams();
  const activeSessionId = searchParams.get("session");

  const { data: allDevices, isPending, error } = useDevices();
  useDevicePresenceSync();

  const devices = (allDevices ?? []).filter((d) => !d.revokedAt);

  // 全部设备在线态（一次性并行；presence 事件经 useDevicePresenceSync 写同一缓存键）。
  const onlineQueries = useQueries({
    queries: devices.map((d) => ({
      queryKey: deviceOnlineQueryKey(d.id),
      queryFn: () => fetchDeviceOnline(d.id),
      staleTime: 30_000,
    })),
  });
  const onlineById = new Map(
    devices.map((d, i) => [d.id, onlineQueries[i]?.data?.online ?? false]),
  );

  // 已展开设备 id 集合。组件挂持久 layout，导航切会话不重置。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const expandedIds = [...expanded];

  // 每个展开设备并行拉会话（走 device-query 单例往返，正常秒回）。
  const sessionQueries = useQueries({
    queries: expandedIds.map((id) => ({
      queryKey: remoteSessionsQueryKey(id),
      queryFn: () =>
        remoteQuery(id, "sessions", {}) as Promise<SessionSummary[]>,
      staleTime: 15_000,
    })),
  });
  const sessionsById = new Map(
    expandedIds.map((id, i) => [id, sessionQueries[i]]),
  );

  if (!slot) return null;

  const toggle = (deviceId: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(deviceId);
      else next.delete(deviceId);
      return next;
    });
  };

  const sessionChildren = (deviceId: string): NavNode[] => {
    const q = sessionsById.get(deviceId);
    if (!q || q.isPending) {
      return [{ key: `${deviceId}:__skeleton__`, label: tDevices("empty") }];
    }
    if (q.isError) {
      return [{ key: `${deviceId}:__error__`, label: t("remoteLoadFailed") }];
    }
    const sessions = q.data ?? [];
    if (sessions.length === 0) {
      return [{ key: `${deviceId}:__empty__`, label: t("remoteEmpty") }];
    }
    return sessions.map((s) => ({
      key: `session:${s.id}`,
      label: <span title={s.title}>{s.title}</span>,
      icon: <Sparkles className="text-(--shell-sidebar-fg)/60" />,
      onClick: () => router.push(`/assistant/${deviceId}?session=${s.id}`),
    }));
  };

  const items: NavNode[] = devices.map((d) => {
    const online = onlineById.get(d.id) ?? false;
    const open = expanded.has(d.id);
    return {
      key: `device:${d.id}`,
      label: d.name,
      defaultOpen: open,
      // 在线设备恒给 children（撑出 chevron）；离线无 children、不可展开、置灰。
      children: online
        ? open
          ? sessionChildren(d.id)
          : [{ key: `${d.id}:__ph__`, label: "" }]
        : undefined,
    };
  });

  const renderRow = (node: NavNode, defaults: SidebarRowProps) => {
    if (node.key.startsWith("device:")) {
      const deviceId = node.key.slice("device:".length);
      const online = onlineById.get(deviceId) ?? false;
      return (
        <SidebarRow
          {...defaults}
          icon={
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                online ? "bg-[#16a34a]" : "bg-(--shell-sidebar-fg)/30",
              )}
            />
          }
          actions={
            online ? (
              <button
                type="button"
                title={t("newSession")}
                onClick={(e) => {
                  e.stopPropagation();
                  router.push(`/assistant/${deviceId}`);
                }}
                className="flex h-6 w-6 items-center justify-center rounded text-(--shell-sidebar-fg)/60 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
              >
                <SquarePen className="h-3.5 w-3.5" />
              </button>
            ) : undefined
          }
        />
      );
    }
    // 骨架/空/错误/占位子行：纯弱化提示，不复用可点的 SidebarRow。
    if (node.key.includes("__")) {
      const isPh = node.key.endsWith("__ph__");
      return (
        <div
          className="flex h-7 items-center truncate pl-[22px] pr-2 text-[12px] text-(--shell-sidebar-fg)/45"
          aria-hidden={isPh}
        >
          {isPh ? "" : node.label}
        </div>
      );
    }
    return <SidebarRow {...defaults} />;
  };

  return createPortal(
    <div className="flex h-full flex-col">
      <SidebarHeader title={t("title")} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {error ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {tDevices("loadFailed")}
          </div>
        ) : isPending ? (
          <TreeSkeleton />
        ) : devices.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {tDevices("empty")}
          </div>
        ) : (
          <SidebarNav
            groups={[{ key: "devices", items }]}
            activeKey={
              activeSessionId ? `session:${activeSessionId}` : undefined
            }
            onToggle={(node, open) => {
              if (node.key.startsWith("device:")) {
                toggle(node.key.slice("device:".length), open);
              }
            }}
            renderRow={renderRow}
          />
        )}
      </div>
    </div>,
    slot,
  );
}

/** 树首载骨架：设备行形状（在线点 + 变宽文字条），非整块 spinner。 */
function TreeSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden>
      {["w-24", "w-20", "w-16"].map((w) => (
        <div key={w} className="flex items-center gap-2 px-2 py-1">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-(--shell-sidebar-fg)/15" />
          <span
            className={cn(
              "h-3 animate-pulse rounded bg-(--shell-sidebar-fg)/15",
              w,
            )}
          />
        </div>
      ))}
    </div>
  );
}
