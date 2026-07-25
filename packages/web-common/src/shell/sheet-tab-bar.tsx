"use client";

import { cn } from "@meshbot/design";

export interface SheetTabItem {
  key: string;
  label: string;
  disabled?: boolean;
  /** disabled=true 时的 title 提示文案（如「无可用内容」），调用方注入。 */
  disabledHint?: string;
}

interface SheetTabBarProps {
  items: SheetTabItem[];
  active: string;
  /** variant="steps" 时非点击型（步骤随流程推进），可省略。 */
  onChange?: (key: string) => void;
  /**
   * tabs（默认）：可点击切换，选中项底部橙色下划线；
   * steps：不可点击的步骤指示（编号圆点 + 箭头），当前步骤高亮，用于新建态
   * 「步骤条」——同一组件两种呈现，样式同族。
   */
  variant?: "tabs" | "steps";
}

/** Sheet 标题栏下的轻量 tab 条：底 border 承担标题分隔线，选中项 2px 橙色下划线。 */
export function SheetTabBar({
  items,
  active,
  onChange,
  variant = "tabs",
}: SheetTabBarProps) {
  if (variant === "steps") {
    const activeIndex = items.findIndex((it) => it.key === active);
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        {items.map((it, index) => (
          <div key={it.key} className="flex items-center gap-2">
            {index > 0 && (
              <span aria-hidden className="text-muted-foreground/40">
                →
              </span>
            )}
            <span
              className={cn(
                "flex items-center gap-1.5 text-[13px] font-medium",
                index === activeIndex
                  ? "text-(--shell-accent)"
                  : index < activeIndex
                    ? "text-foreground/70"
                    : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full text-[11px]",
                  index === activeIndex
                    ? "bg-(--shell-accent) text-white"
                    : index < activeIndex
                      ? "bg-foreground/15 text-foreground/70"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {index + 1}
              </span>
              {it.label}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-end gap-1 border-b border-border px-4">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          disabled={it.disabled}
          title={it.disabled ? it.disabledHint : undefined}
          onClick={() => onChange?.(it.key)}
          className={cn(
            "-mb-px border-b-2 px-2.5 pb-2 pt-1 text-[13px] font-medium transition-colors",
            active === it.key
              ? "border-(--shell-accent) text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
            it.disabled &&
              "cursor-not-allowed opacity-40 hover:text-muted-foreground",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
