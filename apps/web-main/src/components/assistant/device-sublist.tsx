"use client";

import { cn, Skeleton } from "@meshbot/design";
import { SidebarHeader, SidebarRow } from "@meshbot/web-common/shell";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createPortal } from "react-dom";
import { useSidebarSlot } from "@/components/shell/sidebar-slot-context";
import { useDeviceOnline, useDevicePresenceSync } from "@/rest/agent-devices";
import { useDevices } from "@/rest/devices";

/**
 * 助手区二级子栏：已授权设备列表（在线点 + 名称），portal 进 WorkspaceSidebar 的
 * 子栏插槽。点击设备行跳 `/assistant/[deviceId]` 详情占位页；已吊销设备不出现——
 * 它们不再跑 Agent，与 `/settings/devices` 表格（含吊销）语义区分。
 */
export function DeviceSublist() {
  const t = useTranslations("assistantSidebar");
  const tDevices = useTranslations("devices");
  const router = useRouter();
  const pathname = usePathname();
  const slot = useSidebarSlot();
  const { data: allDevices, isPending, error } = useDevices();
  // presence 实时变化写入各设备的 useDeviceOnline 缓存，本组件只需订阅一次。
  useDevicePresenceSync();

  if (!slot) return null;

  const devices = (allDevices ?? []).filter((d) => !d.revokedAt);

  return createPortal(
    <div className="flex h-full flex-col">
      <SidebarHeader title={t("title")} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {error ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {tDevices("loadFailed")}
          </div>
        ) : isPending ? (
          <DeviceSublistSkeleton />
        ) : devices.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {tDevices("empty")}
          </div>
        ) : (
          <div className="space-y-0.5">
            {devices.map((d) => (
              <DeviceSublistRow
                key={d.id}
                id={d.id}
                name={d.name}
                active={pathname === `/assistant/${d.id}`}
                onClick={() => router.push(`/assistant/${d.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>,
    slot,
  );
}

interface DeviceSublistRowProps {
  id: string;
  name: string;
  active: boolean;
  onClick: () => void;
}

/** 单设备行：在线点（首屏走 useDeviceOnline，实时变化走 presence 缓存）+ 名称。 */
function DeviceSublistRow({
  id,
  name,
  active,
  onClick,
}: DeviceSublistRowProps) {
  const { data } = useDeviceOnline(id);
  const online = data?.online ?? false;
  return (
    <SidebarRow
      icon={
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            online ? "bg-[#16a34a]" : "bg-(--shell-sidebar-fg)/30",
          )}
        />
      }
      label={name}
      active={active}
      onClick={onClick}
    />
  );
}

/** 区块首载骨架：贴近真实行形状（在线点 + 变宽文字条），非整块 spinner。 */
const SKELETON_ROW_WIDTHS = ["w-24", "w-20", "w-16"] as const;

function DeviceSublistSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden>
      {SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex items-center gap-2 px-2 py-1">
          <Skeleton className="h-2 w-2 shrink-0 rounded-full" />
          <Skeleton className={cn("h-3 rounded", width)} />
        </div>
      ))}
    </div>
  );
}
