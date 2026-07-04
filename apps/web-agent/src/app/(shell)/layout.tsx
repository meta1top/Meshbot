"use client";

import { cn } from "@meshbot/design";
import { useAtom } from "jotai";
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
  assistantPanelWidthAtom,
  sidebarDrawerOpenAtom,
} from "@/atoms/assistant-panel";
import { DragRegion } from "@/components/drag-region";
import { ShellRefsContext } from "@/components/layouts/shell-refs-context";
import { RightZone } from "@/components/shell/right-zone";
import { ShellTopBar } from "@/components/shell/shell-top-bar";
import { WorkspaceRail } from "@/components/shell/workspace-rail";
import { useGlobalEvents } from "@/hooks/use-global-events";

function ShellInner({ children }: { children: ReactNode }) {
  const t = useTranslations("appShell");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [panelOpen, setPanelOpen] = useAtom(assistantPanelOpenAtom);
  const [, setSidebarDrawerOpen] = useAtom(sidebarDrawerOpenAtom);
  useGlobalEvents();
  const [assistantWidth, setAssistantWidth] = useAtom(assistantPanelWidthAtom);
  const [isResizing, setIsResizing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const effectiveWidth = `${assistantWidth}px`;

  const startPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const cw = contentRef.current?.clientWidth ?? window.innerWidth;
      const sw = sidebarRef.current?.clientWidth ?? 0;
      const avail = cw - sw;
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

  const sp = searchParams.toString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 pathname / query 变化时收起
  useEffect(() => {
    setSidebarDrawerOpen(false);
  }, [pathname, sp, setSidebarDrawerOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSidebarDrawerOpen(false);
      setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarDrawerOpen, setPanelOpen]);

  return (
    <ShellRefsContext.Provider value={{ sidebarRef }}>
      <main className="titlebar-safe flex h-screen flex-col bg-(--shell-chrome) text-foreground">
        <DragRegion />
        <ShellTopBar />
        <div className="flex min-h-0 flex-1">
          <WorkspaceRail />
          <div
            ref={contentRef}
            className="relative flex min-h-0 flex-1 overflow-hidden pr-1.5 pb-1.5"
          >
            {children}
            {panelOpen && (
              <div
                aria-hidden
                onMouseDown={startPanelResize}
                className="group hidden w-2 shrink-0 cursor-col-resize xl:flex xl:items-center"
              >
                <div className="mx-auto h-12 w-1 rounded-full bg-white/20 transition-colors group-hover:bg-(--shell-accent)" />
              </div>
            )}
            {panelOpen && (
              <button
                type="button"
                aria-label={t("assistant")}
                onClick={() => setPanelOpen(false)}
                className="absolute top-0 right-1.5 bottom-1.5 left-0 z-30 rounded-(--shell-radius) bg-black/50 xl:hidden"
              />
            )}
            <aside
              style={{ width: effectiveWidth }}
              className={cn(
                "z-40 flex shrink-0 overflow-hidden bg-(--shell-content)",
                "absolute top-0 bottom-1.5 right-0 max-w-[88vw] rounded-(--shell-radius) shadow-2xl transition-transform duration-200",
                panelOpen ? "translate-x-0" : "translate-x-full",
                "xl:static xl:z-auto xl:max-w-none xl:translate-x-0 xl:rounded-(--shell-radius) xl:shadow-none xl:transition-none",
                !panelOpen && "xl:hidden",
              )}
            >
              <RightZone />
            </aside>
            {isResizing && (
              <div className="fixed inset-0 z-50 cursor-col-resize" />
            )}
          </div>
        </div>
      </main>
    </ShellRefsContext.Provider>
  );
}

/** (shell) 段共享布局：持久骨架（rail/topbar/dock/resize），切 page 不 remount。 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <ShellInner>{children}</ShellInner>
    </Suspense>
  );
}
