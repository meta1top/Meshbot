"use client";
import { UnifiedSheet } from "@meshbot/web-common/shell";
import { useAtom, useAtomValue } from "jotai";
import { Sparkles, X } from "lucide-react";
import {
  assistantDockWidthAtom,
  assistantPanelOpenAtom,
  previewArtifactAtom,
  quickAssistantNameAtom,
} from "@/atoms/assistant-panel";
import { AssistantDock } from "@/components/im/assistant-dock";
import { DockTabs } from "@/components/im/dock-tabs";

/**
 * 随手问：右下角浮动气泡；点击展开为「右侧全高浮层面板」。
 * 面板高度沾满整窗，左缘可拖拽调宽（默认 30% 窗宽 / 最小 380px，拖后按 px 记住）。
 * ESC 收起、条件挂载、拖拽区规则均由 UnifiedSheet 统一底座承担。
 */
export function QuickAssistantFab() {
  const [open, setOpen] = useAtom(assistantPanelOpenAtom);
  const name = useAtomValue(quickAssistantNameAtom);
  const [width, setWidth] = useAtom(assistantDockWidthAtom);
  const previewArtifact = useAtomValue(previewArtifactAtom);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={name}
        title={name}
        className="absolute right-4 bottom-20 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-(--shell-accent) text-white shadow-lg shadow-(--shell-accent)/30 transition-transform hover:scale-105"
      >
        <Sparkles className="h-5 w-5" />
      </button>
    );
  }

  return (
    <UnifiedSheet
      open={open}
      onOpenChange={setOpen}
      width={width}
      onWidthChange={setWidth}
      // 默认 30% 窗宽（下限 380px、上限 92vw）；调过后按存的 px 走。
      defaultWidth="30vw"
      className="app-no-drag"
      title={
        <>
          <Sparkles className="h-4 w-4 text-(--shell-accent)" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
            {name}
          </span>
        </>
      }
      headerActions={
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="close"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      }
      // 助手 dock 与产物预览「共存」场景下，标题区换成助手⇄预览 tab
      // （assistant-dock.tsx 原 DockTabs 用法平移，语义不变）。
      headerTabs={previewArtifact && <DockTabs />}
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        <AssistantDock chromeless />
      </div>
    </UnifiedSheet>
  );
}
