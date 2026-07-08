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
}: SidebarRowProps) {
  return (
    <div
      className={cn(
        "group/row flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0",
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
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing}
      </button>
      {actions && (
        <span className="shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-data-[state=open]:opacity-100">
          {actions}
        </span>
      )}
    </div>
  );
}
