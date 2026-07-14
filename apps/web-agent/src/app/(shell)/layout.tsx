"use client";

import { ResizableSheet } from "@meshbot/web-common/shell";
import { useAtom } from "jotai";
import { type ReactNode, Suspense, useEffect, useState } from "react";
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
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);

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
        <div className="relative flex min-h-0 flex-1 overflow-hidden bg-(--shell-content)">
          <SidebarSlotContext.Provider value={slotEl}>
            {children}
          </SidebarSlotContext.Provider>
          {/* 产物预览：右侧全高浮层（与随手问助手同形态）；左缘拖拽调宽，
              z 抬到拖拽条（z-9999）之上 → 顶部下载/关闭按钮可点、不被 app-region:drag 吞。
              条件挂载而非常驻 + transform 滑入：合成器 transform 不触发布局变化，
              Electron 不重算 draggable regions——常驻模式下打开面板后顶部按钮的
              no-drag 洞停留在收起态快照，首次点击被拖拽区吞掉（助手面板即条件
              挂载无此问题）。挂载产生真实布局变化，regions 必然重算。 */}
          {hasArtifact && (
            <ResizableSheet
              width={assistantWidth}
              onWidthChange={setAssistantWidth}
              // 默认 50% 窗宽（下限 480px）；调过后按存的 px 走。
              defaultWidth="50vw"
              // app-no-drag：z 抬到拖拽条（z-9999）之上，顶部下载/关闭按钮才不被
              // app-region:drag 吞。入场用 animation（不是 transition）——sheet 的
              // width 靠内联样式实时写，任何 transition-duration 都会让它滞后于鼠标。
              className="app-no-drag animate-in fade-in slide-in-from-right-4"
            >
              <ArtifactSplitPane />
            </ResizableSheet>
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
