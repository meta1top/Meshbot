"use client";

import { cn, DropdownMenu, DropdownMenuTrigger } from "@meshbot/design";
import { Fragment, type ReactNode } from "react";

interface RailIconItem {
  key: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  /** 提供时该项为下拉触发器（传入 DropdownMenuContent），点击展开而非 onClick 切区。 */
  dropdown?: ReactNode;
}

export interface RailIconStripProps {
  items: RailIconItem[];
  className?: string;
}

/**
 * 一级区域图标条（横向）：一排图标 + 极小标签，当前区焦橙高亮。
 * 放在 WorkspaceSidebar 顶部，点击切区（onClick 由容器接路由）；
 * 带 dropdown 的项（如「更多」）点击展开下拉菜单。
 */
export function RailIconStrip({ items, className }: RailIconStripProps) {
  return (
    <nav
      className={cn("grid gap-1 px-2", className)}
      style={{
        gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
      }}
    >
      {items.map((it) => {
        const btn = (
          <button
            key={it.key}
            type="button"
            onClick={it.onClick}
            title={it.label}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg py-2 text-[9.5px] font-semibold transition-colors [&_svg]:h-5 [&_svg]:w-5",
              it.active
                ? "bg-(--shell-accent)/12 text-(--shell-accent)"
                : "text-(--shell-sidebar-fg)/65 hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)",
            )}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        );
        return it.dropdown ? (
          <DropdownMenu key={it.key}>
            <DropdownMenuTrigger asChild>{btn}</DropdownMenuTrigger>
            {it.dropdown}
          </DropdownMenu>
        ) : (
          <Fragment key={it.key}>{btn}</Fragment>
        );
      })}
    </nav>
  );
}
