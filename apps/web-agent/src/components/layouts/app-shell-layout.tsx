"use client";

import { cn } from "@meshbot/design";
import { clearAccessToken } from "@meshbot/web-common";
import { useTheme } from "@meshbot/web-common/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { Clock, LogOut, Moon, Plus, Sun } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import {
  loadSessionsAtom,
  pinnedSessionsAtom,
  recentSessionsAtom,
  reloadSessionsAtom,
  sessionsStatusAtom,
} from "@/atoms/sessions";
import { SidebarNavItem } from "@/components/common/sidebar-nav-item";
import { DragRegion } from "@/components/drag-region";
import { LanguageToggle } from "@/components/language-toggle";
import { SessionListSection } from "@/components/sidebar/session-list-section";
import { SessionListSkeleton } from "@/components/sidebar/session-list-skeleton";

interface AppShellLayoutProps {
  children: React.ReactNode;
  className?: string;
  /** 暴露内部滚动容器 ref，供子页面读取/操作 scrollTop（如分页锚定）。 */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export function AppShellLayout({
  children,
  className,
  scrollContainerRef,
}: AppShellLayoutProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  const t = useTranslations("appShell");
  const commonT = useTranslations("common");
  const pathname = usePathname();
  const isNewSessionActive = pathname === "/";
  const isScheduledActive = pathname === "/schedule";
  const [isMac, setIsMac] = useState(false);

  const pinned = useAtomValue(pinnedSessionsAtom);
  const recent = useAtomValue(recentSessionsAtom);
  const status = useAtomValue(sessionsStatusAtom);
  const loadSessions = useSetAtom(loadSessionsAtom);
  const reload = useSetAtom(reloadSessionsAtom);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    document.body.classList.add("app-shell-mode");
    const api = (window as unknown as { electronAPI?: { platform?: string } })
      .electronAPI;
    if (api?.platform === "darwin") {
      setIsMac(true);
    }
    return () => {
      document.body.classList.remove("app-shell-mode");
    };
  }, []);

  const handleLogout = useCallback(() => {
    clearAccessToken();
    queryClient.invalidateQueries({ queryKey: ["auth", "status"] });
    router.replace("/login");
  }, [queryClient, router]);

  return (
    <main className="titlebar-safe h-screen bg-background text-foreground">
      <DragRegion />
      <div className="flex h-full">
        <aside className="hidden w-[246px] shrink-0 px-1.5 py-1.5 lg:flex lg:flex-col">
          <div
            className={cn(
              "flex h-full flex-col border border-border bg-muted px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
              isMac && "rounded-l-[12px]",
            )}
          >
            {isMac && <div className="app-mac-controls-safe-left mb-2 h-8" />}
            <nav className="space-y-0.5">
              <SidebarNavItem
                icon={<Plus className="h-4 w-4" />}
                active={isNewSessionActive}
                onClick={() => router.push("/")}
              >
                {t("newSession")}
              </SidebarNavItem>
              <SidebarNavItem
                icon={<Clock className="h-4 w-4" />}
                active={isScheduledActive}
                onClick={() => router.push("/schedule")}
              >
                {t("scheduled")}
              </SidebarNavItem>
            </nav>

            {/*
              会话列表区域：flex-1 + min-h-0 让它在 aside 里占满剩余空间但不撑高，
              overflow-y-auto 让超出时内部滚动；外面的 nav 顶 / logout 底保持可见。
              -mx-2.5 + px-2.5 抵消滚动条裁切感（让 hover bg 仍能贴边）。
            */}
            <div className="-mx-2.5 mt-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5">
              {pinned.length > 0 && (
                <SessionListSection title={t("pinned")} sessions={pinned} />
              )}

              {status === "loading" ? (
                <div className="mt-5">
                  <div className="px-2 text-[12px] font-medium text-muted-foreground">
                    {t("sessions")}
                  </div>
                  <SessionListSkeleton />
                </div>
              ) : status === "error" ? (
                <div className="mt-5 px-2 text-xs text-destructive">
                  {t("loadFailed")}{" "}
                  <button
                    type="button"
                    onClick={() => void reload()}
                    className="underline hover:text-destructive/80"
                  >
                    {t("retry")}
                  </button>
                </div>
              ) : (
                <SessionListSection title={t("sessions")} sessions={recent} />
              )}
            </div>

            <div className="mt-2 flex items-center justify-between px-2">
              <button
                type="button"
                onClick={handleLogout}
                className="flex items-center gap-2 rounded-md py-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <LogOut className="h-3.5 w-3.5" />
                {t("logout")}
              </button>
              <div className="flex items-center gap-1.5">
                <LanguageToggle />
                <button
                  type="button"
                  onClick={toggleTheme}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  title={
                    theme === "dark"
                      ? commonT("switchToLightTheme")
                      : commonT("switchToDarkTheme")
                  }
                >
                  {theme === "dark" ? (
                    <Sun className="h-3.5 w-3.5" />
                  ) : (
                    <Moon className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </aside>

        <section className="relative flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollContainerRef}
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-y-auto",
              className,
            )}
          >
            <div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col p-4 lg:px-10">
              {children}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
