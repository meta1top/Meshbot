"use client";

import { clearAccessToken } from "@meshbot/web-common";
import { useTheme } from "@meshbot/web-common/react";
import { cn } from "@meshbot/design";
import { useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  Grip,
  LogOut,
  Moon,
  MoreHorizontal,
  Pin,
  Plus,
  Sun,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { SidebarNavItem } from "@/components/common/sidebar-nav-item";
import { DragRegion } from "@/components/drag-region";
import { LanguageToggle } from "@/components/language-toggle";

interface AppShellLayoutProps {
  children: React.ReactNode;
  className?: string;
}

export function AppShellLayout({ children, className }: AppShellLayoutProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  const t = useTranslations("appShell");
  const commonT = useTranslations("common");
  const pathname = usePathname();
  const isNewSessionActive = pathname === "/";
  const isScheduledActive = pathname === "/schedule";
  const [isMac, setIsMac] = useState(false);

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

            <div className="mt-8 px-2 text-[12px] font-medium text-muted-foreground">
              {t("pinned")}
            </div>
            <div className="mt-1 space-y-0.5 text-[14px]">
              <button
                type="button"
                className="group flex w-full items-center justify-between rounded-none px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-white"
              >
                <div className="flex items-center gap-2">
                  <Pin className="h-3.5 w-3.5 text-muted-foreground group-hover:text-white" />
                  <span>{t("dragToPin")}</span>
                </div>
                <span className="opacity-0 transition-opacity group-hover:opacity-100">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </span>
              </button>
            </div>

            <div className="mt-5 px-2 text-[12px] font-medium text-muted-foreground">
              {t("recents")}
            </div>
            <div className="mt-1 space-y-0.5 text-[14px]">
              <button
                type="button"
                className="group flex w-full items-center justify-between rounded-none px-2 py-1.5 text-left text-foreground/80 hover:bg-accent hover:text-white"
              >
                <div className="flex items-center gap-2">
                  <Grip className="h-3.5 w-3.5 text-muted-foreground group-hover:text-white" />
                  <span>{t("addMarketplacePlugin")}</span>
                </div>
                <span className="opacity-0 transition-opacity group-hover:opacity-100">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </span>
              </button>
              <button
                type="button"
                className="group flex w-full items-center justify-between rounded-none px-2 py-1.5 text-left text-foreground/80 hover:bg-accent hover:text-white"
              >
                <div className="flex items-center gap-2">
                  <Grip className="h-3.5 w-3.5 text-muted-foreground group-hover:text-white" />
                  <span>{t("respondToUserGreeting")}</span>
                </div>
                <span className="opacity-0 transition-opacity group-hover:opacity-100">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </span>
              </button>
            </div>

            <div className="mt-auto flex items-center justify-between px-2">
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
