"use client";

import { SidebarSection, SidebarSkeleton } from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { sessionsAtom, sessionsStatusAtom } from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { SessionListItem } from "@/components/sidebar/session-list-item";

/**
 * 助手二级侧栏:本机设备 Agent 的会话列表(单一「本机」分组)。
 * 跨设备分组待云端设备信息,当前 web-agent 本地只有本机一台。
 * 数据与消息侧栏共用 loadSidebarAtom(一次请求填会话+助手,带 guard 不重复拉)。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const router = useRouter();
  const sessions = useAtomValue(sessionsAtom);
  const status = useAtomValue(sessionsStatusAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);

  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-13 shrink-0 items-center justify-between px-3.5">
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {status === "idle" || status === "loading" ? (
          <SidebarSkeleton />
        ) : (
          <SidebarSection title={t("thisDevice")}>
            {status === "error" ? (
              <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
                {t("loadFailed")}
              </div>
            ) : sessions.length === 0 ? (
              <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
                {t("empty")}
              </div>
            ) : (
              sessions.map((s) => <SessionListItem key={s.id} session={s} />)
            )}
          </SidebarSection>
        )}
      </div>
    </div>
  );
}
