"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

interface Props {
  /** 前置图标（svg 统一渲染为 h-3.5 w-3.5；非 svg 自带尺寸，如在线圆点）。 */
  icon?: ReactNode;
  label: ReactNode;
  active?: boolean;
  onClick?: () => void;
  /** 右侧附加内容（未读 badge 等）。 */
  trailing?: ReactNode;
}

/**
 * 统一侧栏导航项（一级项）：图标 + 文字 + 可选右侧 badge + 高亮态。
 * 各页 sidebar（文件/更多/技能/消息频道·私信）共用，统一高度 h-7、间距、图标尺寸、
 * 高亮态，消除各页自拼 rowBase 的差异。带 inline 编辑/菜单的会话项另由专用组件承担。
 */
export function SidebarNavItem({
  icon,
  label,
  active,
  onClick,
  trailing,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0",
        active
          ? "bg-(--shell-content) text-(--shell-sidebar-fg) shadow-sm"
          : "text-(--shell-sidebar-fg)/80 hover:bg-(--shell-sidebar-hover)",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}
