"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue } from "jotai";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  assistantPanelOpenAtom,
  assistantPanelTypeAtom,
  assistantPanelWidthAtom,
  previewArtifactAtom,
  previewPanelWidthAtom,
  sidebarDrawerOpenAtom,
} from "@/atoms/assistant-panel";
import { ArtifactPreviewPanel } from "@/components/artifact/artifact-preview-panel";
import { DragRegion } from "@/components/drag-region";
import { AssistantDock } from "@/components/im/assistant-dock";
import { MessagesSidebar } from "@/components/shell/messages-sidebar";
import { MoreSidebar } from "@/components/shell/more-sidebar";
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
}

/**
 * 应用外壳布局（响应式）：
 * - rail 常驻；内容区始终全宽。
 * - 消息侧栏：md+ 内联；< md 收为左侧滑出抽屉（顶栏汉堡控制）。
 * - 随手问 dock：xl+ 内联并列（可拖宽）；< xl 收为右侧滑出抽屉（顶栏 ✦ 控制）。
 * 抽屉单实例常驻挂载，靠 translate 滑入/滑出（关闭时移出屏外，由外层 overflow-hidden 裁剪），
 * 故 dock 后台流不因开关而退订。遮罩点击 / Esc 关闭；点会话/切路由自动收侧栏抽屉。
 */
export function AppShellLayout({
  children,
  className,
  scrollContainerRef,
  sidebar,
  header,
}: AppShellLayoutProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("appShell");
  const area = areaFromPath(pathname);
  const [panelOpen, setPanelOpen] = useAtom(assistantPanelOpenAtom);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useAtom(
    sidebarDrawerOpenAtom,
  );
  // Shell 级全局事件总线订阅：常驻于壳，任何页面都能实时更新未读/会话/在线/定时任务。
  useGlobalEvents();
  const [assistantWidth, setAssistantWidth] = useAtom(assistantPanelWidthAtom);
  const [previewWidth, setPreviewWidth] = useAtom(previewPanelWidthAtom);
  const [isResizing, setIsResizing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [availW, setAvailW] = useState(0);
  const panelType = useAtomValue(assistantPanelTypeAtom);
  const previewArtifact = useAtomValue(previewArtifactAtom);
  const isPreview = panelType === "preview" && !!previewArtifact;
  // 预览宽用独立 atom（与助手各自记忆，切换时切换宽度）；0 = 默认内容区 50%。
  const effectiveWidth = isPreview
    ? previewWidth > 0
      ? `${previewWidth}px`
      : availW > 0
        ? `${Math.round(availW * 0.5)}px`
        : "50vw"
    : `${assistantWidth}px`;

  // 内容区可用宽 = 内容区容器 − 左侧消息侧栏（不含 rail/侧栏），dock 宽度上限基于它。
  useEffect(() => {
    const update = () => {
      const cw = contentRef.current?.clientWidth ?? 0;
      const sw = sidebarRef.current?.clientWidth ?? 0;
      setAvailW(cw - sw);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // 面板左缘拖拽改宽（仅 xl+ 内联态）：基于内容区可用宽，助手 ≤50%、预览 ≤90%。
  const startPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const cw = contentRef.current?.clientWidth ?? window.innerWidth;
      const sw = sidebarRef.current?.clientWidth ?? 0;
      const avail = cw - sw;
      const maxW = isPreview
        ? Math.round(avail * 0.9)
        : Math.round(avail * 0.5);
      const startW = isPreview
        ? previewWidth > 0
          ? previewWidth
          : Math.round(avail * 0.5)
        : assistantWidth;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          Math.max(startW + (startX - ev.clientX), 300),
          maxW,
        );
        if (isPreview) {
          setPreviewWidth(next);
        } else {
          setAssistantWidth(next);
        }
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        setIsResizing(false);
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [
      isPreview,
      assistantWidth,
      previewWidth,
      setAssistantWidth,
      setPreviewWidth,
    ],
  );

  useEffect(() => {
    document.body.classList.add("app-shell-mode");
    return () => document.body.classList.remove("app-shell-mode");
  }, []);

  // 切路由 / 切会话（query 变化）后自动收起侧栏抽屉（窄屏点会话即跳转）。
  const sp = searchParams.toString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 pathname / query 变化时收起
  useEffect(() => {
    setSidebarDrawerOpen(false);
  }, [pathname, sp, setSidebarDrawerOpen]);

  // Esc 关闭已打开的抽屉。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSidebarDrawerOpen(false);
      setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarDrawerOpen, setPanelOpen]);

  const autoSidebar =
    area === "messages" ? (
      <Suspense fallback={null}>
        <MessagesSidebar />
      </Suspense>
    ) : area === "more" ? (
      <MoreSidebar />
    ) : null;
  const resolvedSidebar = sidebar === undefined ? autoSidebar : sidebar;

  return (
    <main className="titlebar-safe flex h-screen flex-col bg-(--shell-chrome) text-foreground">
      {/* 保留 DragRegion：Electron Linux 窗口控制按钮 + macOS 安全区由它承载 */}
      <DragRegion />
      <ShellTopBar />
      <div className="flex min-h-0 flex-1">
        <WorkspaceRail />
        {/* 内容区容器：relative + overflow-hidden 承载抽屉（绝对定位、关闭时滑出屏外被裁剪） */}
        <div
          ref={contentRef}
          className="relative flex min-h-0 flex-1 overflow-hidden pr-1.5 pb-1.5"
        >
          {/* 侧栏遮罩：仅 < md 抽屉打开时 */}
          {resolvedSidebar && sidebarDrawerOpen && (
            <button
              type="button"
              aria-label={t("rail.messages")}
              onClick={() => setSidebarDrawerOpen(false)}
              className="absolute top-0 right-1.5 bottom-1.5 left-0 z-30 rounded-(--shell-radius) bg-black/50 md:hidden"
            />
          )}

          {/* 消息侧栏：md+ 内联；< md 左侧滑出抽屉。单实例常驻，translate 滑动。 */}
          {resolvedSidebar && (
            <aside
              ref={sidebarRef}
              className={cn(
                "z-40 flex flex-col w-[260px] shrink-0 overflow-hidden bg-(--shell-sidebar) transition-transform duration-200",
                // 抽屉态：底部留出壳的 gutter（与内容容器 pb-1.5 一致）+ 全圆角浮起卡片
                "absolute top-0 bottom-1.5 left-0 rounded-(--shell-radius) shadow-2xl",
                sidebarDrawerOpen ? "translate-x-0" : "-translate-x-full",
                // 内联态还原：去右圆角与内容卡无缝拼接（基类已给左圆角），bottom-1.5 在 static 下被忽略
                "md:static md:z-auto md:w-[240px] md:translate-x-0 md:rounded-r-none md:shadow-none md:transition-none",
              )}
            >
              {resolvedSidebar}
            </aside>
          )}

          {/* 内容卡 */}
          <section
            className={cn(
              "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-(--shell-content)",
              resolvedSidebar
                ? "rounded-(--shell-radius) md:rounded-l-none"
                : "rounded-(--shell-radius)",
            )}
          >
            {header}
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
          </section>

          {/* 随手问 resize 手柄：仅 xl+ 内联态、面板打开时 */}
          {panelOpen && (
            <div
              aria-hidden
              onMouseDown={startPanelResize}
              className="group hidden w-2 shrink-0 cursor-col-resize xl:flex xl:items-center"
            >
              <div className="mx-auto h-12 w-1 rounded-full bg-white/20 transition-colors group-hover:bg-(--shell-accent)" />
            </div>
          )}

          {/* 随手问面板遮罩：仅 < xl 抽屉打开时 */}
          {panelOpen && (
            <button
              type="button"
              aria-label={t("assistant")}
              onClick={() => setPanelOpen(false)}
              className="absolute top-0 right-1.5 bottom-1.5 left-0 z-30 rounded-(--shell-radius) bg-black/50 xl:hidden"
            />
          )}

          {/* 随手问 dock：常驻挂载（关闭不卸载，后台流不退订）。xl+ 内联；< xl 右侧滑出抽屉。 */}
          <aside
            style={{ width: effectiveWidth }}
            className={cn(
              "z-40 flex shrink-0 overflow-hidden bg-(--shell-content)",
              // 抽屉态：底部留出壳的 gutter（与内容容器 pb-1.5 一致）+ 全圆角浮起卡片
              "absolute top-0 bottom-1.5 right-0 max-w-[88vw] rounded-(--shell-radius) shadow-2xl transition-transform duration-200",
              panelOpen ? "translate-x-0" : "translate-x-full",
              "xl:static xl:z-auto xl:max-w-none xl:translate-x-0 xl:rounded-(--shell-radius) xl:shadow-none xl:transition-none",
              !panelOpen && "xl:hidden",
            )}
          >
            {panelType === "preview" && previewArtifact ? (
              <ArtifactPreviewPanel />
            ) : (
              <AssistantDock />
            )}
          </aside>
        </div>
      </div>
      {/* 拖拽改宽时盖一层全屏遮罩：盖住 iframe（预览）等，避免鼠标移上去 iframe 吞掉 mousemove 导致拖拽卡住。 */}
      {isResizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </main>
  );
}
