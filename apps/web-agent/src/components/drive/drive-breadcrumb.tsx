"use client";

import { cn } from "@meshbot/design";
import { ChevronRight, HardDrive } from "lucide-react";
import { useTranslations } from "next-intl";

/** 面包屑层级项。 */
export interface BreadcrumbEntry {
  id: string;
  name: string;
}

interface DriveBreadcrumbProps {
  /** 当前路径栈（不含根）。 */
  pathStack: BreadcrumbEntry[];
  /** 点击某层级时的跳转回调，index = -1 表示跳回根。 */
  onJump: (index: number) => void;
  className?: string;
}

/**
 * 网盘路径面包屑：渲染「根 / 夹1 / 夹2」，点击跳层。
 * 纯展示组件，状态由父层 page 维护。
 */
export function DriveBreadcrumb({
  pathStack,
  onJump,
  className,
}: DriveBreadcrumbProps) {
  const t = useTranslations("drive");

  return (
    <nav
      className={cn("flex items-center gap-1 text-sm", className)}
      aria-label="breadcrumb"
    >
      {/* 根目录 */}
      <button
        type="button"
        onClick={() => onJump(-1)}
        className={cn(
          "flex items-center gap-1 rounded px-1 py-0.5 transition-colors",
          pathStack.length === 0
            ? "text-foreground font-medium cursor-default"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
        )}
        aria-current={pathStack.length === 0 ? "page" : undefined}
      >
        <HardDrive className="h-3.5 w-3.5 shrink-0" />
        <span>{t("rootLabel")}</span>
      </button>

      {/* 各层级 */}
      {pathStack.map((entry, index) => {
        const isLast = index === pathStack.length - 1;

        return (
          <span key={entry.id} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => onJump(index)}
              className={cn(
                "rounded px-1 py-0.5 transition-colors max-w-[160px] truncate",
                isLast
                  ? "text-foreground font-medium cursor-default"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              aria-current={isLast ? "page" : undefined}
              title={entry.name}
            >
              {entry.name}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
