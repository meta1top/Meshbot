"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

interface RailIconItem {
  key: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

export interface RailIconStripProps {
  items: RailIconItem[];
  className?: string;
}

/**
 * 一级区域图标条（横向）：一排图标 + 极小标签，当前区焦橙高亮。
 * 放在 WorkspaceSidebar 顶部，点击切区（onClick 由容器接路由）。
 */
export function RailIconStrip({ items, className }: RailIconStripProps) {
  return (
    <nav
      className={cn(
        "grid gap-1 px-2 [grid-template-columns:repeat(6,minmax(0,1fr))]",
        className,
      )}
    >
      {items.map((it) => (
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
      ))}
    </nav>
  );
}
