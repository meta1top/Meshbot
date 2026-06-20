"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue } from "jotai";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, Suspense, useCallback, useEffect } from "react";
import {
  assistantPanelOpenAtom,
  assistantPanelWidthAtom,
} from "@/atoms/assistant-panel";
import { DragRegion } from "@/components/drag-region";
import { AssistantDock } from "@/components/im/assistant-dock";
import { MessagesSidebar } from "@/components/shell/messages-sidebar";
import { PlaceholderSidebar } from "@/components/shell/placeholder-sidebar";
import { ShellTopBar } from "@/components/shell/shell-top-bar";
import { WorkspaceRail } from "@/components/shell/workspace-rail";
import { useGlobalEvents } from "@/hooks/use-global-events";
import { areaFromPath } from "@/lib/area-from-path";

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
  const panelOpen = useAtomValue(assistantPanelOpenAtom);
  // Shell 级全局事件总线订阅：常驻于壳，任何页面都能实时更新未读/会话/在线/定时任务。
  useGlobalEvents();
  const [panelWidth, setPanelWidth] = useAtom(assistantPanelWidthAtom);

  // 随手问面板左缘拖拽改宽：面板在右侧，鼠标左移→变宽；clamp 300–640；持久化在 atom。
  const startPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panelWidth;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          Math.max(startW + (startX - ev.clientX), 300),
          640,
        );
        setPanelWidth(next);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [panelWidth, setPanelWidth],
  );

  useEffect(() => {
    document.body.classList.add("app-shell-mode");
    return () => document.body.classList.remove("app-shell-mode");
  }, []);

  const autoSidebar =
    area === "messages" ? (
      <Suspense fallback={null}>
        <MessagesSidebar />
      </Suspense>
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
                  <div className="flex w-full flex-1 flex-col p-4 lg:px-6">
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
                <div className="flex w-full flex-1 flex-col p-4 lg:px-6">
                  {children}
                </div>
              </div>
            )}
          </section>
          {panelOpen && (
            <>
              {/* 拖拽手柄：占内容区与随手问之间那条缝（平时透明露深色壳，hover 显橙色竖条）。 */}
              <div
                aria-hidden
                onMouseDown={startPanelResize}
                className="group hidden w-1.5 shrink-0 cursor-col-resize xl:flex"
              >
                <div className="mx-auto h-full w-0.5 rounded-full transition-colors group-hover:bg-(--shell-accent)/60" />
              </div>
              <aside
                style={{ width: panelWidth }}
                className="hidden shrink-0 overflow-hidden rounded-(--shell-radius) bg-(--shell-content) xl:flex"
              >
                <AssistantDock />
              </aside>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
