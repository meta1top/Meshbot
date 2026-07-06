"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronRight, FolderClosed, MonitorSmartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import {
  deviceOnlineAtom,
  devicesAtom,
  loadDevicesAtom,
} from "@/atoms/devices";

/**
 * 起手台 composer 下方目标选择器行：
 * 选择 Agent（默认本机，下拉列该账号所有设备，离线置灰）+ 选择工作空间（占位）。
 * 与助手侧栏共用 devicesAtom。L2b 阶段选中项仅存本地 state（远程执行属 L3）。
 */
export function ComposerTargetBar() {
  const t = useTranslations("composer");
  const devices = useAtomValue(devicesAtom);
  const online = useAtomValue(deviceOnlineAtom);
  const loadDevices = useSetAtom(loadDevicesAtom);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const local = useMemo(() => devices.find((d) => d.isCurrent), [devices]);
  const selected = devices.find((d) => d.id === selectedId) ?? local ?? null;
  const selectedLabel =
    selected && !selected.isCurrent ? selected.name : t("agentLocal");

  return (
    <div className="mt-2 flex items-center gap-4 px-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <MonitorSmartphone className="h-3.5 w-3.5" />
            {selectedLabel}
            <ChevronRight className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[180px]">
          {devices
            .filter((d) => !d.revokedAt)
            .map((d) => {
              const isOnline = d.isCurrent || (online[d.id] ?? false);
              return (
                <DropdownMenuItem
                  key={d.id}
                  disabled={!isOnline}
                  onClick={() => setSelectedId(d.id)}
                  className="flex items-center gap-2"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-[#16a34a]" : "bg-muted-foreground/40"}`}
                  />
                  <span className="truncate">
                    {d.isCurrent ? t("agentLocal") : d.name}
                  </span>
                </DropdownMenuItem>
              );
            })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 选择工作空间：默认工作区（agent 文件工作区，后续接真实目录） */}
      <button
        type="button"
        title={t("comingSoon")}
        className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <FolderClosed className="h-3.5 w-3.5" />
        {t("workspaceDefault")}
        <ChevronRight className="h-3 w-3 opacity-60" />
      </button>
    </div>
  );
}
