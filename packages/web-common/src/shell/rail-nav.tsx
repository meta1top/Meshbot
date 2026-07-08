"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

export interface RailNavItemModel {
  key: string;
  icon: ReactNode;
  label: ReactNode;
}

export interface RailNavProps {
  items: RailNavItemModel[];
  activeKey?: string;
  onSelect: (key: string) => void;
  orientation: "horizontal" | "vertical";
  className?: string;
}

/** 一级区域 rail：横排（宽 sidebar 顶部条，web-agent）或竖排（窄 rail，web-main）。 */
export function RailNav({
  items,
  activeKey,
  onSelect,
  orientation,
  className,
}: RailNavProps) {
  if (orientation === "horizontal") {
    return (
      <nav
        className={cn("grid gap-1", className)}
        style={{
          gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
        }}
      >
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
            title={typeof it.label === "string" ? it.label : undefined}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg py-2 text-[9.5px] font-semibold transition-colors [&_svg]:h-5 [&_svg]:w-5",
              it.key === activeKey
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
  return (
    <nav className={cn("flex flex-col gap-1", className)}>
      {items.map((it) => {
        const active = it.key === activeKey;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
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
              {it.icon}
            </span>
            <span className="text-[10px] leading-none">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
