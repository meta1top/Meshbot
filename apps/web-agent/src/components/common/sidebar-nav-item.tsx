"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

interface SidebarNavItemProps {
  icon: ReactNode;
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}

export function SidebarNavItem({
  icon,
  children,
  active = false,
  onClick,
  className,
}: SidebarNavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-2 rounded-none px-2 py-1.5 text-left text-[14px] transition-colors",
        active
          ? "bg-accent font-medium text-white"
          : "text-foreground/80 hover:bg-accent hover:text-white",
        className,
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center transition-colors",
          active
            ? "text-white"
            : "text-muted-foreground group-hover:text-white",
        )}
      >
        {icon}
      </span>
      {children}
    </button>
  );
}
