"use client";

import { cn } from "@meshbot/design";
import { useAtom } from "jotai";
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
  const t = useTranslations("rightZone");
  const [previewArtifact, setPreviewArtifact] = useAtom(previewArtifactAtom);
  const hasArtifact = previewArtifact != null;
  useGlobalEvents();
  const [assistantWidth, setAssistantWidth] = useAtom(assistantPanelWidthAtom);
  const [isResizing, setIsResizing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const effectiveWidth = `${assistantWidth}px`;

  const startPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const avail = contentRef.current?.clientWidth ?? window.innerWidth;
      const maxW = Math.round(avail * 0.5);
      const startW = assistantWidth;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          Math.max(startW + (startX - ev.clientX), 300),
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

  return (
    <main className="titlebar-safe flex h-screen flex-col bg-(--shell-page) text-foreground">
      <DragRegion />
      <div className="m-3 flex min-h-0 flex-1 overflow-hidden rounded-xl border border-(--shell-sidebar-border) bg-(--shell-content) shadow-sm">
        <WorkspaceSidebar sublistSlotRef={setSlotEl} />
        <div
          ref={contentRef}
          className="relative flex min-h-0 flex-1 overflow-hidden bg-(--shell-content)"
        >
          <SidebarSlotContext.Provider value={slotEl}>
            {children}
          </SidebarSlotContext.Provider>
          {hasArtifact && (
            <div
              aria-hidden
              onMouseDown={startPanelResize}
              className="group hidden w-2 shrink-0 cursor-col-resize xl:flex xl:items-center"
            >
              <div className="mx-auto h-12 w-1 rounded-full bg-white/20 transition-colors group-hover:bg-(--shell-accent)" />
            </div>
          )}
          {hasArtifact && (
            <button
              type="button"
              aria-label={t("artifactClose")}
              onClick={() => setPreviewArtifact(null)}
              className="absolute top-0 right-1.5 bottom-1.5 left-0 z-30 rounded-(--shell-radius) bg-black/50 xl:hidden"
            />
          )}
          <aside
            style={{ width: effectiveWidth }}
            className={cn(
              "z-40 flex shrink-0 overflow-hidden bg-(--shell-content)",
              "absolute top-0 bottom-1.5 right-0 max-w-[88vw] rounded-(--shell-radius) shadow-2xl transition-transform duration-200",
              hasArtifact ? "translate-x-0" : "translate-x-full",
              "xl:static xl:z-auto xl:max-w-none xl:translate-x-0 xl:rounded-(--shell-radius) xl:shadow-none xl:transition-none",
              !hasArtifact && "xl:hidden",
            )}
          >
            <ArtifactSplitPane />
          </aside>
          {isResizing && (
            <div className="fixed inset-0 z-50 cursor-col-resize" />
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
