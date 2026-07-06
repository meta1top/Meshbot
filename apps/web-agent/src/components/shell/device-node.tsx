"use client";

import type { DeviceView } from "@meshbot/types";
import { SidebarSkeleton } from "@meshbot/web-common/shell";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sessionsAtom, sessionsStatusAtom } from "@/atoms/sessions";
import { SessionListItem } from "@/components/sidebar/session-list-item";

/**
 * 助手两级树的一级节点：一台设备（agent）。
 * - 本机（isCurrent）：展开列本地会话（sessionsAtom）；默认展开。
 * - 其他设备：展开占位「远程会话查看即将支持」（L2c 接实时拉取）；离线置灰不可展开。
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
  const canExpand = device.isCurrent || online;
  const label = device.isCurrent
    ? `${device.name}（${t("thisDevice")}）`
    : device.name;

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
          ) : (
            <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
              {t("remoteComingSoon")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
