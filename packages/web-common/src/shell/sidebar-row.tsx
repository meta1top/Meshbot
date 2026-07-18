"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

export interface SidebarRowProps {
  /** 前置图标（svg 统一渲染为 h-3.5 w-3.5；非 svg 自带尺寸，如在线圆点）。 */
  icon?: ReactNode;
  label: ReactNode;
  active?: boolean;
  /** 缩进级数（0 起）；每级左内边距递增，供多级树使用。 */
  depth?: number;
  /** 右侧附加内容（未读 badge / 在线点等，常驻；非交互，随行整体可点）。 */
  trailing?: ReactNode;
  /** 右侧操作区（三点菜单等，hover 显示；与 trailing 可并存）。 */
  actions?: ReactNode;
  onClick?: () => void;
  /** 提供则渲染为链接语义（仍走 onClick 由容器接路由，这里仅占位以备将来）。 */
  href?: string;
  /**
   * label 是否为两行结构（主标题 + 副标题，如远程 Agent 行的「名字 + 设备名」）。
   * 默认 false = 单行死高 h-7；为 true 时改用 `min-h-9 py-1`，让 hover/选中的
   * 圆角背景块跟着内容长高——否则两行内容（约 32px）在 28px 的盒子里上下溢出，
   * 表现为「文字比色块高、色块包不住」并挤压相邻行间距。
   */
  twoLine?: boolean;
}

/**
 * 统一侧栏行：图标 + 文字 + depth 缩进 + 可选 trailing/actions + 高亮态。
 * SidebarNav 内部逐行渲染它；带内联编辑/菜单的会话行也直接组合它（把编辑/菜单塞进
 * actions 或外层），从而复用同一套高度 h-7/间距/图标尺寸/高亮 class，消除各处手抄。
 */
export function SidebarRow({
  icon,
  label,
  active,
  depth = 0,
  trailing,
  actions,
  onClick,
  twoLine = false,
}: SidebarRowProps) {
  return (
    <div
      className={cn(
        "group/row flex w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0",
        twoLine ? "min-h-9 py-1" : "h-7",
        active
          ? "bg-(--shell-content) text-(--shell-sidebar-fg) shadow-sm"
          : "text-(--shell-sidebar-fg)/80 hover:bg-(--shell-sidebar-hover)",
      )}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {icon}
        {/* 单行仍用 truncate（长名字省略号）；两行必须换成纯 overflow-hidden——
            truncate 自带的 whitespace-nowrap 会把第二行下沿裁掉，且两行结构的
            内层 span 已各自 truncate，外层不需要再管省略号。 */}
        <span
          className={cn(
            "min-w-0 flex-1",
            twoLine ? "overflow-hidden" : "truncate",
          )}
        >
          {label}
        </span>
        {trailing}
      </button>
      {actions && (
        <span className="flex shrink-0 items-center self-stretch opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-data-[state=open]:opacity-100">
          {actions}
        </span>
      )}
    </div>
  );
}
