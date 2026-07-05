"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

interface RailNavItemProps {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

/**
 * 最左 rail 的导航项：图标方块 + 下方文字标签。
 * 选中态高亮只作用于图标方块（半透明白），文字标签无背景，仅由暗→白提亮。
 */
export function RailNavItem({
  icon,
  label,
  active = false,
  onClick,
}: RailNavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full flex-col items-center gap-1 py-1 transition-colors",
        active ? "text-white" : "text-white/65 hover:text-white",
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-(--shell-radius) transition-colors",
          active ? "bg-(--shell-accent)" : "hover:bg-white/10",
        )}
      >
        {icon}
      </span>
      <span className="text-[10px] leading-none">{label}</span>
    </button>
  );
}
