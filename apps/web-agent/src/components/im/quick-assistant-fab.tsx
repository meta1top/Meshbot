"use client";
import { ResizableSheet } from "@meshbot/web-common/shell";
import { useAtom, useAtomValue } from "jotai";
import { Sparkles, X } from "lucide-react";
import { useEffect } from "react";
import {
  assistantDockWidthAtom,
  assistantPanelOpenAtom,
  quickAssistantNameAtom,
} from "@/atoms/assistant-panel";
import { AssistantDock } from "@/components/im/assistant-dock";

/**
 * 随手问：右下角浮动气泡；点击展开为「右侧全高浮层面板」。
 * 面板高度沾满整窗，左缘可拖拽调宽（默认 30% 窗宽 / 最小 380px，拖后按 px 记住）。
 * z 抬到拖拽条（DragRegion, z-9999）之上，头部按钮天然可点、不被 app-region:drag 吞。
 */
export function QuickAssistantFab() {
  const [open, setOpen] = useAtom(assistantPanelOpenAtom);
  const name = useAtomValue(quickAssistantNameAtom);
  const [width, setWidth] = useAtom(assistantDockWidthAtom);

  // 展开态按 ESC 收起（与 X 同义）；无展开时不挂监听。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

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
    <ResizableSheet
      width={width}
      onWidthChange={setWidth}
      // 默认 30% 窗宽（下限 380px、上限 92vw）；调过后按存的 px 走。
      defaultWidth="30vw"
      // app-no-drag：z 抬到拖拽条（DragRegion, z-9999）之上，头部按钮才可点。
      className="app-no-drag"
    >
      {/* 头部（高度对齐会话头 h-13）：drag-handle 恢复窗口拖动（面板整体
          app-no-drag 挖掉了顶部拖拽条），按钮再 app-no-drag 凿洞保持可点。 */}
      <div className="drag-handle flex h-13 shrink-0 items-center gap-2 border-b border-border pr-3 pl-4">
        <Sparkles className="h-4 w-4 text-(--shell-accent)" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {name}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="close"
          className="app-no-drag flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AssistantDock chromeless />
      </div>
    </ResizableSheet>
  );
}
