"use client";

import { cn, Skeleton } from "@meshbot/design";
import { SidebarHeader, SidebarRow } from "@meshbot/web-common/shell";
import { ChevronLeft, Sparkles, SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { createPortal } from "react-dom";
import { useSidebarSlot } from "@/components/shell/sidebar-slot-context";
import { useRemoteSessions } from "@/hooks/use-remote-sessions";
import { createRemoteSessionTransport } from "@/lib/session-transport";

interface SessionSublistProps {
  deviceId: string;
  deviceName: string;
  /** 设备当前在线态：离线时不发起 `listSessions()`（网关会较快 offline
   * reject，但不主动尝试，避免用户能感知到的等待），只显示提示行。 */
  online: boolean;
  activeSessionId: string | null;
}

/**
 * 助手区三级子栏：某台设备的远程会话列表（`/assistant/[deviceId]` 页面用），
 * portal 进与 `DeviceSublist` 相同的侧栏插槽——同一时刻只有一个子栏可见，
 * 进入设备详情页时天然替换掉设备列表（`AssistantDevicePage` 二选一渲染）。
 *
 * 结构沿用 `apps/web-agent/src/components/shell/assistant-sidebar.tsx` 的
 * 「设备 → 会话」思路，简化为「单设备会话列表」（web-main 按路由分设备页，
 * 不需要 web-agent 那种全设备一棵树 + 展开/懒加载语义）。
 */
export function SessionSublist({
  deviceId,
  deviceName,
  online,
  activeSessionId,
}: SessionSublistProps) {
  const t = useTranslations("assistantSidebar");
  const router = useRouter();
  const slot = useSidebarSlot();
  const transport = useMemo(
    () => createRemoteSessionTransport(deviceId),
    [deviceId],
  );
  const {
    data: sessions,
    isPending,
    isError,
  } = useRemoteSessions(deviceId, transport, online);

  if (!slot) return null;

  return createPortal(
    <div className="flex h-full flex-col">
      <SidebarHeader
        title={deviceName}
        action={
          <button
            type="button"
            title={t("newSession")}
            disabled={!online}
            onClick={() => router.push(`/assistant/${deviceId}`)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg) disabled:pointer-events-none disabled:opacity-40"
          >
            <SquarePen className="h-4 w-4" />
          </button>
        }
      />
      <button
        type="button"
        onClick={() => router.push("/assistant")}
        className="mx-3 mt-1 flex items-center gap-1 text-[12px] text-(--shell-sidebar-fg)/55 hover:text-(--shell-sidebar-fg)"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        {t("backToDevices")}
      </button>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {!online ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {t("offlineSessionsHint")}
          </div>
        ) : isPending ? (
          <SessionSublistSkeleton />
        ) : isError ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {t("remoteLoadFailed")}
          </div>
        ) : (sessions?.length ?? 0) === 0 ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {t("remoteEmpty")}
          </div>
        ) : (
          <div className="space-y-0.5">
            {sessions?.map((s) => (
              <SidebarRow
                key={s.id}
                icon={<Sparkles className="text-(--shell-sidebar-fg)/60" />}
                label={<span title={s.title}>{s.title}</span>}
                active={s.id === activeSessionId}
                onClick={() =>
                  router.push(`/assistant/${deviceId}?session=${s.id}`)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>,
    slot,
  );
}

/** 区块首载骨架：贴近真实行形状（图标 + 变宽文字条），非整块 spinner。 */
const SKELETON_ROW_WIDTHS = ["w-28", "w-20", "w-24"] as const;

function SessionSublistSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden>
      {SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex items-center gap-2 px-2 py-1">
          <Skeleton className="h-4 w-4 shrink-0 rounded" />
          <Skeleton className={cn("h-3 rounded", width)} />
        </div>
      ))}
    </div>
  );
}
