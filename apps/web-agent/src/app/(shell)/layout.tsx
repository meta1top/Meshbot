"use client";

import { UnifiedSheet } from "@meshbot/web-common/shell";
import { useAtom } from "jotai";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import {
  assistantPanelWidthAtom,
  previewArtifactAtom,
} from "@/atoms/assistant-panel";
import {
  ArtifactSplitPane,
  ArtifactSplitPaneActions,
  useArtifactSplitPaneTitle,
} from "@/components/artifact/artifact-split-pane";
import { DragRegion } from "@/components/drag-region";
import { QuickAssistantFab } from "@/components/im/quick-assistant-fab";
import { GlobalAlertHost } from "@/components/shell/global-alert-host";
import { SidebarSlotContext } from "@/components/shell/sidebar-slot-context";
import { WorkspaceSidebar } from "@/components/shell/workspace-sidebar";
import { useGlobalEvents } from "@/hooks/use-global-events";

function ShellInner({ children }: { children: ReactNode }) {
  const [previewArtifact, setPreviewArtifact] = useAtom(previewArtifactAtom);
  const hasArtifact = previewArtifact != null;
  const artifactTitle = useArtifactSplitPaneTitle();
  useGlobalEvents();
  const [assistantWidth, setAssistantWidth] = useAtom(assistantPanelWidthAtom);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    document.body.classList.add("app-shell-mode");
    return () => document.body.classList.remove("app-shell-mode");
  }, []);

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
          {/* 产物预览：右侧全高浮层（与随手问助手同形态）。条件挂载 + 拖拽区
              规则见 UnifiedSheet 文件头注释。默认 50% 窗宽（下限 480px），
              调过后按存的 px 走；入场用 animation（不是 transition）——sheet 的
              width 靠内联样式实时写，任何 transition-duration 都会让它滞后于鼠标。 */}
          <UnifiedSheet
            open={hasArtifact}
            onOpenChange={(open) => !open && setPreviewArtifact(null)}
            width={assistantWidth}
            onWidthChange={setAssistantWidth}
            defaultWidth="50vw"
            className="app-no-drag animate-in fade-in slide-in-from-right-4"
            title={artifactTitle}
            headerActions={<ArtifactSplitPaneActions />}
          >
            <ArtifactSplitPane />
          </UnifiedSheet>
          <QuickAssistantFab />
        </div>
      </div>
      <GlobalAlertHost />
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
