"use client";

import { SidebarSkeleton } from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  deviceOnlineAtom,
  devicesAtom,
  devicesStatusAtom,
  loadDevicesAtom,
} from "@/atoms/devices";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { DeviceNode } from "@/components/shell/device-node";

/**
 * 助手二级侧栏：设备两级树。一级 = 该账号所有注册设备（本机 + 其他，带在线点），
 * 展开本机 → 本地会话；其他设备展开为占位（远程查看属 L2c）。
 * 本地会话经 loadSidebarAtom 载入（sessionsAtom），设备列表经 loadDevicesAtom 载入。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const router = useRouter();
  const devices = useAtomValue(devicesAtom);
  const devicesStatus = useAtomValue(devicesStatusAtom);
  const online = useAtomValue(deviceOnlineAtom);
  const loadDevices = useSetAtom(loadDevicesAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);

  useEffect(() => {
    void loadSidebar();
    void loadDevices();
  }, [loadSidebar, loadDevices]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between px-3">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
        <button
          type="button"
          title={t("newSession")}
          onClick={() => router.push("/assistant")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {devicesStatus === "idle" || devicesStatus === "loading" ? (
          <SidebarSkeleton />
        ) : devicesStatus === "error" ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {t("devicesLoadFailed")}
          </div>
        ) : (
          devices
            .filter((d) => !d.revokedAt)
            .map((d) => (
              <DeviceNode
                key={d.id}
                device={d}
                online={d.isCurrent || (online[d.id] ?? false)}
              />
            ))
        )}
      </div>
    </div>
  );
}
