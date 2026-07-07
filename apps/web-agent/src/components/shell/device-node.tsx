"use client";

import { cn } from "@meshbot/design";
import type { DeviceView } from "@meshbot/types";
import type { SessionSummary } from "@meshbot/types-agent";
import { SidebarSkeleton } from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { deviceOnlineAtom } from "@/atoms/devices";
import {
  loadRemoteSessionsAtom,
  remoteSessionsAtom,
} from "@/atoms/remote-sessions";
import { sessionsAtom, sessionsStatusAtom } from "@/atoms/sessions";
import { SessionListItem } from "@/components/sidebar/session-list-item";
import { fetchDeviceOnline } from "@/rest/devices";

/**
 * 助手两级树的一级节点：一台设备（agent）。
 * - 本机（isCurrent）：展开列本地会话（sessionsAtom）；默认展开。
 * - 其他设备：展开时按需拉该设备会话列表（remoteSessionsAtom，经 relay 只读
 *   查询）+ 重探一次在线态（缓解 deviceOnlineAtom 陈旧）；点击会话进入只读
 *   历史视图 `/assistant?remoteDevice=<id>&id=<sid>`；离线置灰不可展开。
 */
export function DeviceNode({
  device,
  online,
}: {
  device: DeviceView;
  online: boolean;
}) {
  const t = useTranslations("assistantSidebar");
  const [open, setOpen] = useState(device.isCurrent);
  const sessions = useAtomValue(sessionsAtom);
  const sessionsStatus = useAtomValue(sessionsStatusAtom);
  const remoteState = useAtomValue(remoteSessionsAtom)[device.id];
  const loadRemoteSessions = useSetAtom(loadRemoteSessionsAtom);
  const setDeviceOnline = useSetAtom(deviceOnlineAtom);
  const canExpand = device.isCurrent || online;
  const label = device.isCurrent
    ? `${device.name}（${t("thisDevice")}）`
    : device.name;

  // 展开远程设备节点：按需拉会话列表 + 重探一次在线态（在线态可能已陈旧——
  // 首屏并发探测后设备可能已上线/下线，展开动作是「用户主动关心这台设备」
  // 的信号，借机刷新一次比等下次整页重探更及时）。
  useEffect(() => {
    if (!open || device.isCurrent) return;
    void loadRemoteSessions(device.id);
    fetchDeviceOnline(device.id)
      .then((v) => setDeviceOnline((m) => ({ ...m, [device.id]: v })))
      .catch(() => {
        // 探测失败保留原在线态，不强行判离线（避免网络抖动误判）
      });
  }, [open, device.id, device.isCurrent, loadRemoteSessions, setDeviceOnline]);

  return (
    <div className="mb-1">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] font-semibold text-(--shell-sidebar-fg) transition-colors hover:bg-(--shell-sidebar-hover) disabled:opacity-50"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        )}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-[#16a34a]" : "bg-(--shell-sidebar-fg)/30"}`}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {!online && !device.isCurrent && (
          <span className="shrink-0 text-[11px] text-(--shell-sidebar-fg)/50">
            {t("offline")}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-4 border-(--shell-line) border-l pl-1.5">
          {device.isCurrent ? (
            sessionsStatus === "idle" || sessionsStatus === "loading" ? (
              <SidebarSkeleton />
            ) : sessions.length === 0 ? (
              <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
                {t("empty")}
              </div>
            ) : (
              sessions.map((s) => <SessionListItem key={s.id} session={s} />)
            )
          ) : !remoteState || remoteState.status === "loading" ? (
            <SidebarSkeleton />
          ) : remoteState.status === "error" ? (
            <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
              {t("remoteLoadFailed")}
            </div>
          ) : remoteState.sessions.length === 0 ? (
            <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
              {t("remoteEmpty")}
            </div>
          ) : (
            remoteState.sessions.map((s) => (
              <RemoteSessionItem key={s.id} deviceId={device.id} session={s} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 远程会话只读列表项。刻意不复用 SessionListItem——那个组件会导航到本地
 * `/assistant?id=` 并带改名/删除菜单，均不适用于远程只读场景。点击直接跳
 * 到只读历史视图。
 */
function RemoteSessionItem({
  deviceId,
  session,
}: {
  deviceId: string;
  session: SessionSummary;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active =
    pathname === "/assistant" &&
    searchParams.get("remoteDevice") === deviceId &&
    searchParams.get("id") === session.id;

  return (
    <button
      type="button"
      onClick={() =>
        router.push(`/assistant?remoteDevice=${deviceId}&id=${session.id}`)
      }
      title={session.title}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors",
        active
          ? "bg-(--shell-content) text-(--shell-sidebar-fg) shadow-sm"
          : "text-(--shell-sidebar-fg)/85 hover:bg-(--shell-sidebar-hover)",
      )}
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-(--shell-sidebar-fg)/60" />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
    </button>
  );
}
