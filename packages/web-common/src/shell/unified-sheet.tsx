"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface UnifiedSheetProps {
  /** 是否展开；false 时整体不挂载（不渲染 DOM），见文件头规则 3。 */
  open: boolean;
  /** 关闭意图上报（ESC / 点遮罩 / 调用方自定义关闭按钮）。 */
  onOpenChange: (open: boolean) => void;
  /** 左缘是否可拖拽调宽，默认 true。 */
  resizable?: boolean;
  /** 是否渲染全屏遮罩（点击遮罩按 dismissible 分流），默认 false。 */
  modal?: boolean;
  /** ESC / 点遮罩是否直接关闭；false 时改为触发 {@link onDismissAttempt}，默认 true。 */
  dismissible?: boolean;
  /** dismissible=false 时，ESC / 点遮罩触发的回调（如提示「有未保存改动」）。 */
  onDismissAttempt?: () => void;
  /** 标题栏文案；传字符串走默认排版，传节点完全自定义。 */
  title?: ReactNode;
  /** 标题栏右侧动作按钮组。 */
  headerActions?: ReactNode;
  /** 标题栏是否画底线，默认 true；headerTabs 存在时恒不画（由 tab 条承担分隔线）。 */
  headerBorder?: boolean;
  /** 标题栏下方的 tab 条（如 {@link SheetTabBar}）。 */
  headerTabs?: ReactNode;
  /** 已保存的宽度（px）；null = 尚未调整过，用 defaultWidth。 */
  width?: number | null;
  /** 松手时提交一次最终宽度（拖动过程中不回调，避免调用方每帧 setState）。 */
  onWidthChange?: (width: number) => void;
  /** 宽度下限（px），默认 480。 */
  minWidth?: number;
  /** 宽度上限占屏比，默认 0.92。 */
  maxVwRatio?: number;
  /** width 为 null 时的默认宽度 CSS，默认 "30vw"。 */
  defaultWidth?: string;
  /** 追加到 aside 的类名（Electron 的 `app-no-drag`、入场动画等由调用方注入）。 */
  className?: string;
  /** 面板正文。 */
  children: ReactNode;
}

/**
 * 统一右侧 Sheet 底座：全参数化的右侧全高浮层面板，取代四处各自为政的
 * 右侧面板实现（产物预览 / 随手问助手 dock / web-main 远程会话等场景后续
 * 逐个迁入）。在 {@link ResizableSheet} 的拖宽能力上加了 modal 遮罩、
 * dismissible 拦截、标题栏 + 动作槽 + tab 条编排、条件挂载。
 *
 * 三条不可动的规则，都是踩过的坑：
 *
 * 1. **aside 上不能有 `transition-duration`（Tailwind 的 `duration-*`）**。CSS 里
 *    `transition-property` 的初始值是 `all`，只要有 duration，拖拽写入的 width 就会
 *    被浏览器拿去补间——面板边缘恒定滞后鼠标一个 duration，看着像「算不过来」，
 *    其实跟内容多少毫无关系。入场动画请用 `animate-*`（animation，不是 transition）。
 * 2. 拖动期间**直接写 DOM 宽度 + rAF 合并**，松手才回调 `onWidthChange`。宽度往往
 *    存在上层 store 里，每帧 setState 会把整棵子树（消息流、产物正文）拖进重渲染。
 * 3. **动作槽是拖动容器（`.drag-handle`）的兄弟节点，不是子节点**。Electron 下
 *    `.drag-handle` 会被识别为可拖拽窗口区域；面板收起态被裁剪时按钮的
 *    no-drag 洞可能未登记，首次点击被拖拽区吞掉，要点到正文触发一次重算才恢复。
 *    按钮不进 drag 矩形就不依赖洞的登记时序。同理，`open=false` 时整体不挂载
 *    （而非用 transform 常驻隐藏）：transform 不触发布局变化，Electron 不会重算
 *    draggable regions；挂载才产生真实布局变化，regions 必然重算。
 */
export function UnifiedSheet({
  open,
  onOpenChange,
  resizable = true,
  modal = false,
  dismissible = true,
  onDismissAttempt,
  title,
  headerActions,
  headerBorder = true,
  headerTabs,
  width,
  onWidthChange,
  minWidth = 480,
  maxVwRatio = 0.92,
  defaultWidth = "30vw",
  className,
  children,
}: UnifiedSheetProps) {
  const asideRef = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);

  const dismiss = useCallback(() => {
    if (dismissible) onOpenChange(false);
    else onDismissAttempt?.();
  }, [dismissible, onOpenChange, onDismissAttempt]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

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
        onWidthChange?.(latest);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [minWidth, maxVwRatio, onWidthChange],
  );

  if (!open) return null; // 条件挂载：迫使 Electron 重算 draggable regions

  const maxVw = `${Math.round(maxVwRatio * 100)}vw`;
  const widthCss =
    width == null
      ? `clamp(${minWidth}px, ${defaultWidth}, ${maxVw})`
      : `clamp(${minWidth}px, ${width}px, ${maxVw})`;

  return (
    <>
      {modal && (
        <div
          data-testid="sheet-overlay"
          className="fixed inset-0 z-9999 bg-black/40"
          onClick={dismiss}
          aria-hidden
        />
      )}
      <aside
        ref={asideRef}
        role="dialog"
        aria-modal={modal || undefined}
        style={{ width: widthCss }}
        className={cn(
          "absolute top-0 right-0 bottom-0 z-10000 flex flex-col overflow-hidden border-l border-border bg-(--shell-content) shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.18)]",
          className,
        )}
      >
        {resizable && (
          // 左缘拖拽手柄（贴内缘，避免被 overflow-hidden 裁掉）
          <button
            type="button"
            aria-label="resize"
            onMouseDown={startResize}
            className="group absolute top-0 bottom-0 left-0 z-10 flex w-2 cursor-col-resize items-stretch"
          >
            <span className="h-full w-px bg-transparent transition-colors group-hover:bg-(--shell-accent)" />
          </button>
        )}
        {/* 标题栏：拖动区（drag-handle）与动作槽为兄弟节点，理由见文件头规则 3 */}
        <div
          className={cn(
            "flex h-13 shrink-0 items-center",
            headerBorder && !headerTabs && "border-b border-border",
          )}
        >
          <div className="drag-handle flex min-w-0 flex-1 items-center gap-2 self-stretch pl-4">
            {typeof title === "string" ? (
              <span className="truncate text-[13px] font-semibold text-foreground">
                {title}
              </span>
            ) : (
              title
            )}
          </div>
          {headerActions && (
            <div className="flex shrink-0 items-center gap-1 pr-3">
              {headerActions}
            </div>
          )}
        </div>
        {headerTabs}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </aside>
      {/* 拖拽时全屏罩：稳住鼠标事件，避免掠过 iframe / 选中文本丢失拖拽 */}
      {resizing && <div className="fixed inset-0 z-10001 cursor-col-resize" />}
    </>
  );
}
