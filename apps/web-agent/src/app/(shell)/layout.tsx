"use client";

import { cn } from "@meshbot/design";
import { useAtom } from "jotai";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  assistantPanelWidthAtom,
  previewArtifactAtom,
} from "@/atoms/assistant-panel";
import { ArtifactSplitPane } from "@/components/artifact/artifact-split-pane";
import { DragRegion } from "@/components/drag-region";
import { QuickAssistantFab } from "@/components/im/quick-assistant-fab";
import { SidebarSlotContext } from "@/components/shell/sidebar-slot-context";
import { WorkspaceSidebar } from "@/components/shell/workspace-sidebar";
import { useGlobalEvents } from "@/hooks/use-global-events";

function ShellInner({ children }: { children: ReactNode }) {
  const [previewArtifact, setPreviewArtifact] = useAtom(previewArtifactAtom);
  const hasArtifact = previewArtifact != null;
  useGlobalEvents();
  const [assistantWidth, setAssistantWidth] = useAtom(assistantPanelWidthAtom);
  const [isResizing, setIsResizing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  // 默认 340px；下限 380px、上限 92vw（与随手问助手同套 clamp 语义）。
  const widthStyle = `clamp(380px, ${assistantWidth}px, 92vw)`;

  const startPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const avail = contentRef.current?.clientWidth ?? window.innerWidth;
      const maxW = Math.round(avail * 0.9);
      const startW = assistantWidth;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          Math.max(startW + (startX - ev.clientX), 380),
          maxW,
        );
        setAssistantWidth(next);
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
    [assistantWidth, setAssistantWidth],
  );

  useEffect(() => {
    document.body.classList.add("app-shell-mode");
    return () => document.body.classList.remove("app-shell-mode");
  }, []);

  // ESC 关产物分栏（随手问 FAB 自己的开关/ESC 由 FAB 自持，这里只管产物）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPreviewArtifact(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPreviewArtifact]);

  // 双栏 shell 侧栏全高贴顶,不用 titlebar-safe 空白带;顶部窗口控件避让
  // 由侧栏品牌行(mac 下移,见 globals.css .sidebar-brand)与 DragRegion 负责。
  return (
    <main className="flex h-screen flex-col bg-(--shell-content) text-foreground">
      <DragRegion />
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar sublistSlotRef={setSlotEl} />
        <div
          ref={contentRef}
          className="relative flex min-h-0 flex-1 overflow-hidden bg-(--shell-content)"
        >
          <SidebarSlotContext.Provider value={slotEl}>
            {children}
          </SidebarSlotContext.Provider>
          {/* 产物预览：右侧全高浮层（与随手问助手同形态）；左缘拖拽调宽，
              z 抬到拖拽条（z-9999）之上 → 顶部下载/关闭按钮可点、不被 app-region:drag 吞。 */}
          <aside
            aria-hidden={!hasArtifact}
            style={{ width: widthStyle }}
            className={cn(
              "app-no-drag absolute top-0 right-0 bottom-0 z-10000 flex flex-col overflow-hidden border-l border-border bg-(--shell-content) shadow-2xl transition-transform duration-200",
              hasArtifact ? "translate-x-0" : "translate-x-full",
            )}
          >
            {/* 左缘拖拽手柄（贴内缘，避免被 overflow-hidden 裁掉） */}
            <button
              type="button"
              aria-label="resize"
              onMouseDown={startPanelResize}
              className="group absolute top-0 bottom-0 left-0 z-10 flex w-2 cursor-col-resize items-stretch"
            >
              <span className="h-full w-px bg-transparent transition-colors group-hover:bg-(--shell-accent)" />
            </button>
            <ArtifactSplitPane />
          </aside>
          {isResizing && (
            <div className="fixed inset-0 z-10001 cursor-col-resize" />
          )}
          <QuickAssistantFab />
        </div>
      </div>
    </main>
  );
}

/** (shell) 段共享布局：持久骨架（sidebar/topbar/dock/resize），切 page 不 remount。 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <ShellInner>{children}</ShellInner>
    </Suspense>
  );
}
