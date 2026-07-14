"use client";

import { cn } from "@meshbot/design";
import type { SessionSummary } from "@meshbot/types-agent";
import {
  SessionTree,
  type SessionTreeLabels,
  type SessionTreeNodeInfo,
} from "@meshbot/web-common/session";
import {
  type NavGroup,
  type NavNode,
  SidebarHeader,
} from "@meshbot/web-common/shell";
import { useQueries } from "@tanstack/react-query";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
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

/** 会话叶子 key 前缀（`session:<sessionId>`）。 */
const SESSION_PREFIX = "session:";

/**
 * 助手区侧栏：设备 → 会话两级展开树（数据装配层，实际树渲染 + 会话行交给共享
 * `SessionTree`，`@meshbot/web-common/session`，与 web-agent 复用同一份交互逻辑）。
 *
 * 渲染进助手段的持久 layout（`(shell)/assistant/layout.tsx`），因此展开态
 * （`expanded` useState）与已加载会话（React Query 缓存）在 `/assistant` ↔
 * `/assistant/[deviceId]` 间导航时不丢——不像旧的「点设备跳独立页」会 remount。
 *
 * - 一级 = 该账号全部已授权设备（在线点 + 名称）；设备节点恒有子节点（撑出
 *   chevron），离线设备的子节点是纯占位（`expandable=false` 时行整体
 *   pointer-events-none，占位内容永远不会被打开渲染）—— 对齐 web-agent
 *   「离线也显示 chevron，置灰不可点」的既有交互；
 * - 展开在线设备 → 并入 `expanded` → `useQueries` 懒加载该设备会话内联铺开，
 *   多设备可同时展开；
 * - 路由携带 `deviceId`（`/assistant/[deviceId]`）时，主动把该设备并入
 *   `expanded`（懒加载其会话列表）；`expanded` 的初始值懒初始化时就带上
 *   首帧 `routeDeviceId`，确保 `defaultOpen` 在 NavItem 首次挂载时就能读到
 *   展开态——否则刷新 / 直达链接会因为 `SidebarNav` 的 `defaultOpen` 只读一次
 *   而被锁死在折叠态，看不到自动展开高亮；
 * - 点会话叶子 → `/assistant/[deviceId]?session=<id>` 打开主区；
 * - 设备行尾不出「新建会话」按钮（不注入 `onNewSession`）：新会话统一从
 *   `/assistant` 起手台发起（选设备 + 写第一句），设备行只负责展开会话列表；
 * - 会话全部远程只读（wire protocol 未提供 rename/delete 能力）：不传
 *   `onRenameSession`/`onDeleteSession`，`SessionTree` 按此自动不出三点菜单。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const tDevices = useTranslations("devices");
  const router = useRouter();
  const slot = useSidebarSlot();
  const searchParams = useSearchParams();
  const activeSessionId = searchParams.get("session");
  const routeParams = useParams<{ deviceId?: string }>();
  const routeDeviceId = routeParams?.deviceId;

  const { data: allDevices, isPending, error } = useDevices();
  useDevicePresenceSync();

  const devices = useMemo(
    () => (allDevices ?? []).filter((d) => !d.revokedAt),
    [allDevices],
  );

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
  // 懒初始化并入首帧路由携带的 deviceId（刷新 / 分享链接直达）——必须在
  // NavItem 首次挂载前就位：NavItem 的展开态只在 mount 时读一次
  // defaultOpen（packages/web-common/src/shell/sidebar-nav.tsx），事后
  // setExpanded 已经追不上，会导致目标设备分支停在折叠态、
  // activeSessionKey 匹配不到任何已渲染节点，无从自动展开高亮。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    routeDeviceId ? new Set([routeDeviceId]) : new Set(),
  );

  // 持久 layout 内后续导航到另一设备（routeDeviceId 变化但组件不 remount）
  // 时同样要并入 expanded，才能展开新目标设备分支。
  useEffect(() => {
    if (!routeDeviceId) return;
    setExpanded((prev) =>
      prev.has(routeDeviceId) ? prev : new Set(prev).add(routeDeviceId),
    );
  }, [routeDeviceId]);

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

  const activeSessionKey = activeSessionId
    ? `${SESSION_PREFIX}${activeSessionId}`
    : undefined;

  // 边装配树边登记每个 key 的渲染元数据，供 SessionTree.nodeInfo 回读。
  const metaByKey = new Map<string, SessionTreeNodeInfo>();

  const sessionChildren = (deviceId: string): NavNode[] => {
    const q = sessionsById.get(deviceId);
    if (!q || q.isPending) {
      metaByKey.set(`ph:${deviceId}:load`, {
        kind: "placeholder",
        variant: "skeleton",
      });
      return [{ key: `ph:${deviceId}:load`, label: "" }];
    }
    if (q.isError) {
      metaByKey.set(`ph:${deviceId}:err`, {
        kind: "placeholder",
        variant: "note",
      });
      return [{ key: `ph:${deviceId}:err`, label: t("remoteLoadFailed") }];
    }
    const sessions = q.data ?? [];
    if (sessions.length === 0) {
      metaByKey.set(`ph:${deviceId}:empty`, {
        kind: "placeholder",
        variant: "note",
      });
      return [{ key: `ph:${deviceId}:empty`, label: t("remoteEmpty") }];
    }
    return sessions.map((s) => {
      const key = `${SESSION_PREFIX}${s.id}`;
      metaByKey.set(key, { kind: "session", title: s.title });
      return {
        key,
        label: s.title,
        onClick: () => router.push(`/assistant/${deviceId}?session=${s.id}`),
      };
    });
  };

  const items: NavNode[] = devices.map((d) => {
    const online = onlineById.get(d.id) ?? false;
    metaByKey.set(`device:${d.id}`, {
      kind: "device",
      online,
      expandable: online,
    });
    return {
      key: `device:${d.id}`,
      label: d.name,
      defaultOpen: expanded.has(d.id) || d.id === routeDeviceId,
      // 恒给非空 children 撑出 chevron；离线设备的占位内容永远不会被打开渲染
      // （expandable=false 时行整体 pointer-events-none，chevron 点不动）。
      children: online
        ? sessionChildren(d.id)
        : [{ key: `ph:${d.id}:offline`, label: "" }],
    };
  });

  const groups: NavGroup[] = [{ key: "devices", items }];

  const handleExpandDevice = (node: NavNode) => {
    const id = node.key.startsWith("device:")
      ? node.key.slice("device:".length)
      : undefined;
    if (!id) return;
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  const labels: SessionTreeLabels = useMemo(
    () => ({ offline: tDevices("offline") }),
    [tDevices],
  );

  if (!slot) return null;

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
          <SessionTree
            groups={groups}
            activeSessionKey={activeSessionKey}
            nodeInfo={(node) => metaByKey.get(node.key)}
            onExpandDevice={handleExpandDevice}
            labels={labels}
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
