"use client";

import { cn } from "@meshbot/design";

export interface SheetTabItem {
  key: string;
  label: string;
  disabled?: boolean;
  /** disabled=true 时的 title 提示文案（如「无可用内容」），调用方注入。 */
  disabledHint?: string;
}

/** Sheet 标题栏下的轻量 tab 条：底 border 承担标题分隔线，选中项 2px 橙色下划线。 */
export function SheetTabBar({
  items,
  active,
  onChange,
}: {
  items: SheetTabItem[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-end gap-1 border-b border-border px-4">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          disabled={it.disabled}
          title={it.disabled ? it.disabledHint : undefined}
          onClick={() => onChange(it.key)}
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
