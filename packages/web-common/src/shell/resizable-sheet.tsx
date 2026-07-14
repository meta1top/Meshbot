"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";

export interface ResizableSheetProps {
  /** 已保存的宽度（px）；null = 尚未调整过，用 defaultWidth。 */
  width: number | null;
  /** 松手时提交一次最终宽度（拖动过程中不回调，避免调用方每帧 setState）。 */
  onWidthChange: (width: number) => void;
  /** 宽度下限（px），默认 480。 */
  minWidth?: number;
  /** 宽度上限占屏比。 */
  maxVwRatio?: number;
  /** width 为 null 时的默认宽度 CSS（如 `30vw`）。 */
  defaultWidth?: string;
  /** 追加到 aside 的类名（Electron 的 `app-no-drag`、入场动画等由调用方注入）。 */
  className?: string;
  children: ReactNode;
}

/**
 * 右侧全高浮层面板，左缘可拖拽调宽。随手问助手 / 产物预览共用。
 *
 * 两条不可动的规则，都是踩过的坑：
 *
 * 1. **aside 上不能有 `transition-duration`（Tailwind 的 `duration-*`）**。CSS 里
 *    `transition-property` 的初始值是 `all`，只要有 duration，拖拽写入的 width 就会
 *    被浏览器拿去补间——面板边缘恒定滞后鼠标一个 duration，看着像「算不过来」，
 *    其实跟内容多少毫无关系。入场动画请用 `animate-*`（animation，不是 transition）。
 * 2. 拖动期间**直接写 DOM 宽度 + rAF 合并**，松手才回调 `onWidthChange`。宽度往往
 *    存在上层 store 里，每帧 setState 会把整棵子树（消息流、产物正文）拖进重渲染。
 */
export function ResizableSheet({
  width,
  onWidthChange,
  minWidth = 480,
  maxVwRatio = 0.92,
  defaultWidth = "30vw",
  className,
  children,
}: ResizableSheetProps) {
  const asideRef = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = asideRef.current?.offsetWidth ?? minWidth;
      const maxW = Math.round(window.innerWidth * maxVwRatio);
      let latest = startW;
      let frame = 0;
      setResizing(true);
      document.body.style.userSelect = "none";

      const paint = () => {
        frame = 0;
        if (asideRef.current) asideRef.current.style.width = `${latest}px`;
      };
      const onMove = (ev: MouseEvent) => {
        latest = Math.min(
          Math.max(startW + (startX - ev.clientX), minWidth),
          maxW,
        );
        // mousemove 一帧可能来好几个，宽度只需写一次
        if (!frame) frame = requestAnimationFrame(paint);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (frame) cancelAnimationFrame(frame);
        document.body.style.userSelect = "";
        setResizing(false);
        onWidthChange(latest);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [minWidth, maxVwRatio, onWidthChange],
  );

  const maxVw = `${Math.round(maxVwRatio * 100)}vw`;
  const widthCss =
    width == null
      ? `clamp(${minWidth}px, ${defaultWidth}, ${maxVw})`
      : `clamp(${minWidth}px, ${width}px, ${maxVw})`;

  return (
    <>
      <aside
        ref={asideRef}
        style={{ width: widthCss }}
        className={cn(
          "absolute top-0 right-0 bottom-0 z-10000 flex flex-col overflow-hidden border-l border-border bg-(--shell-content) shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.18)]",
          className,
        )}
      >
        {/* 左缘拖拽手柄（贴内缘，避免被 overflow-hidden 裁掉） */}
        <button
          type="button"
          aria-label="resize"
          onMouseDown={startResize}
          className="group absolute top-0 bottom-0 left-0 z-10 flex w-2 cursor-col-resize items-stretch"
        >
          <span className="h-full w-px bg-transparent transition-colors group-hover:bg-(--shell-accent)" />
        </button>
        {children}
      </aside>
      {/* 拖拽时全屏罩：稳住鼠标事件，避免掠过 iframe / 选中文本丢失拖拽 */}
      {resizing && <div className="fixed inset-0 z-10001 cursor-col-resize" />}
    </>
  );
}
