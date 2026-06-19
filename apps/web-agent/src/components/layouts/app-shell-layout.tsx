"use client";

import { cn } from "@meshbot/design";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect } from "react";
import { DragRegion } from "@/components/drag-region";
import { ImSidebar } from "@/components/im/im-sidebar";
import { PlaceholderSidebar } from "@/components/shell/placeholder-sidebar";
import { ShellTopBar } from "@/components/shell/shell-top-bar";
import { areaFromPath, WorkspaceRail } from "@/components/shell/workspace-rail";

interface AppShellLayoutProps {
  children: ReactNode;
  className?: string;
  /** 暴露内部滚动容器 ref，供子页面读取/操作 scrollTop（如分页锚定）。 */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** 侧栏覆盖：undefined=按区自动选；null=不渲染侧栏（设置页用）。 */
  sidebar?: ReactNode | null;
  /**
   * 内容卡顶部固定栏（如会话标题栏）。渲染在滚动容器之外、贴卡片顶边，
   * 整条横贯内容卡宽度，不随消息滚动、不受滚动条影响。
   */
  header?: ReactNode;
  /**
   * 右侧并列面板（如 IM 伴生 Agent 侧栏）。提供时内容卡分两列：
   * 左=居中滚动主区，右=固定宽面板（xl 以上显示）；不提供时布局不变。
   */
  rightPanel?: ReactNode;
}

export function AppShellLayout({
  children,
  className,
  scrollContainerRef,
  sidebar,
  header,
  rightPanel,
}: AppShellLayoutProps) {
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const area = areaFromPath(pathname);

  useEffect(() => {
    document.body.classList.add("app-shell-mode");
    return () => document.body.classList.remove("app-shell-mode");
  }, []);

  const autoSidebar =
    area === "messages" ? (
      <ImSidebar />
    ) : area === "more" ? (
      <PlaceholderSidebar title={t("rail.more")} />
    ) : null;
  const resolvedSidebar = sidebar === undefined ? autoSidebar : sidebar;

  return (
    <main className="titlebar-safe flex h-screen flex-col bg-(--shell-chrome) text-foreground">
      {/* 保留 DragRegion：Electron Linux 窗口控制按钮 + macOS 安全区由它承载 */}
      <DragRegion />
      <ShellTopBar />
      <div className="flex min-h-0 flex-1">
        <WorkspaceRail />
        <div className="flex min-h-0 flex-1 pr-1.5 pb-1.5">
          {resolvedSidebar && (
            <aside className="hidden w-[240px] shrink-0 overflow-hidden rounded-l-(--shell-radius) lg:block">
              {resolvedSidebar}
            </aside>
          )}
          <section
            className={cn(
              "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-(--shell-content)",
              resolvedSidebar
                ? "rounded-r-(--shell-radius)"
                : "rounded-(--shell-radius)",
            )}
          >
            {header}
            {rightPanel ? (
              <div className="flex min-h-0 flex-1 flex-row">
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
                <aside className="hidden w-[420px] shrink-0 flex-col border-l border-border xl:flex">
                  {rightPanel}
                </aside>
              </div>
            ) : (
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
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
