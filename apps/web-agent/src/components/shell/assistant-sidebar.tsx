"use client";

import {
  SESSION_WS_EVENTS,
  type SessionTitleUpdatedEvent,
} from "@meshbot/types-agent";
import { useAtomValue, useSetAtom } from "jotai";
import { Clock, SquarePen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  loadSessionsAtom,
  pinnedSessionsAtom,
  recentSessionsAtom,
  reloadSessionsAtom,
  sessionsStatusAtom,
  updateSessionTitleAtom,
} from "@/atoms/sessions";
import { SessionListSection } from "@/components/sidebar/session-list-section";
import { SessionListSkeleton } from "@/components/sidebar/session-list-skeleton";
import { getSessionSocket } from "@/lib/socket";

export function AssistantSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const pinned = useAtomValue(pinnedSessionsAtom);
  const recent = useAtomValue(recentSessionsAtom);
  const status = useAtomValue(sessionsStatusAtom);
  const loadSessions = useSetAtom(loadSessionsAtom);
  const reload = useSetAtom(reloadSessionsAtom);
  const updateSessionTitle = useSetAtom(updateSessionTitleAtom);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const socket = getSessionSocket();
    const onTitleUpdated = (e: SessionTitleUpdatedEvent) =>
      updateSessionTitle({ id: e.sessionId, title: e.title });
    const onConnect = () => void reload();
    socket.on(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
    socket.on("connect", onConnect);
    return () => {
      socket.off(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
      socket.off("connect", onConnect);
    };
  }, [updateSessionTitle, reload]);

  return (
    <div className="flex h-full flex-col bg-[var(--shell-sidebar)] px-2 py-2.5 text-white">
      <div className="flex items-center justify-between border-b border-white/15 px-1.5 pb-2.5">
        <span className="text-[15px] font-extrabold">
          {t("assistantTitle")}
        </span>
        <button
          type="button"
          onClick={() => router.push("/assistant")}
          title={t("newSession")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/80 hover:bg-white/15 hover:text-white"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-1 flex min-h-0 flex-1 flex-col overflow-y-auto">
        {pinned.length > 0 && (
          <SessionListSection title={t("pinned")} sessions={pinned} />
        )}
        {status === "loading" ? (
          <div className="mt-4">
            <div className="px-2 text-[12px] font-medium text-white/70">
              {t("sessions")}
            </div>
            <SessionListSkeleton />
          </div>
        ) : status === "error" ? (
          <div className="mt-4 px-2 text-xs text-white/80">
            {t("loadFailed")}{" "}
            <button
              type="button"
              onClick={() => void reload()}
              className="underline hover:text-white"
            >
              {t("retry")}
            </button>
          </div>
        ) : (
          (recent.length > 0 || pinned.length === 0) && (
            <SessionListSection
              title={t("sessions")}
              sessions={recent}
              emptyText={t("sessionsEmpty")}
            />
          )
        )}
      </div>

      <button
        type="button"
        onClick={() => router.push("/schedule")}
        className={`mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors ${pathname.startsWith("/schedule") ? "bg-white/24 text-white" : "text-white/85 hover:bg-white/12 hover:text-white"}`}
      >
        <Clock className="h-4 w-4" />
        {t("scheduled")}
      </button>
    </div>
  );
}
