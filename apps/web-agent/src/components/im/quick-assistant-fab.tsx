"use client";
import { useAtom, useAtomValue } from "jotai";
import { Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  assistantDockWidthAtom,
  assistantPanelOpenAtom,
  quickAssistantNameAtom,
} from "@/atoms/assistant-panel";
import { AssistantDock } from "@/components/im/assistant-dock";

/** 面板宽度下限（px）与最大占屏比。 */
const MIN_WIDTH = 380;
const MAX_VW_RATIO = 0.92;

/**
 * 随手问：右下角浮动气泡；点击展开为「右侧全高浮层面板」。
 * 面板高度沾满整窗，左缘可拖拽调宽（默认 30% 窗宽 / 最小 380px，拖后按 px 记住）。
 * z 抬到拖拽条（DragRegion, z-9999）之上，头部按钮天然可点、不被 app-region:drag 吞。
 */
export function QuickAssistantFab() {
  const [open, setOpen] = useAtom(assistantPanelOpenAtom);
  const name = useAtomValue(quickAssistantNameAtom);
  const [width, setWidth] = useAtom(assistantDockWidthAtom);
  const [resizing, setResizing] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);

  // 展开态按 ESC 收起（与 X 同义）；无展开时不挂监听。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // 左缘拖拽调宽：面板锚定右侧，向左拖 = 变宽。clamp[380, 92vw]，存 px。
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = asideRef.current?.offsetWidth ?? MIN_WIDTH;
      const maxW = Math.round(window.innerWidth * MAX_VW_RATIO);
      setResizing(true);
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          Math.max(startW + (startX - ev.clientX), MIN_WIDTH),
          maxW,
        );
        setWidth(next);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        setResizing(false);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [setWidth],
  );

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

  // 默认 30% 窗宽（下限 380px、上限 92vw）；调过后用存的 px（同样 clamp）。
  const widthCss =
    width == null
      ? "clamp(380px, 30vw, 92vw)"
      : `clamp(380px, ${width}px, 92vw)`;

  return (
    <>
      <aside
        ref={asideRef}
        style={{ width: widthCss }}
        className="app-no-drag absolute top-0 right-0 bottom-0 z-10000 flex flex-col overflow-hidden border-l border-border bg-(--shell-content) shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.18)]"
      >
        {/* 左缘拖拽手柄（贴面板左内缘，避免被 overflow-hidden 裁掉） */}
        <button
          type="button"
          aria-label="resize"
          onMouseDown={startResize}
          className="group absolute top-0 bottom-0 left-0 z-10 flex w-2 cursor-col-resize items-stretch"
        >
          <span className="h-full w-px bg-transparent transition-colors group-hover:bg-(--shell-accent)" />
        </button>
        {/* 头部（高度对齐会话头 h-13） */}
        <div className="flex h-13 shrink-0 items-center gap-2 border-b border-border pr-3 pl-4">
          <Sparkles className="h-4 w-4 text-(--shell-accent)" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
            {name}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="close"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <AssistantDock chromeless />
        </div>
      </aside>
      {/* 拖拽时全屏罩：稳住鼠标事件，避免掠过 iframe/选中文本丢失拖拽 */}
      {resizing && <div className="fixed inset-0 z-10001 cursor-col-resize" />}
    </>
  );
}
