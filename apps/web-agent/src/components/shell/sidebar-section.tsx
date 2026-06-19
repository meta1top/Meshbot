"use client";

import { cn } from "@meshbot/design";
import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";

interface SidebarSectionProps {
  title: string;
  children: React.ReactNode;
  /** 提供时分段头右侧显示「+」按钮 */
  onAdd?: () => void;
  addLabel?: string;
  /** 默认展开 */
  defaultOpen?: boolean;
}

/**
 * 统一侧栏的可折叠分段：分段头（折叠箭头 + 标题 + 可选「+」）+ 子内容。
 * 频道 / 私信 / 助手三段共用。
 */
export function SidebarSection({
  title,
  children,
  onAdd,
  addLabel,
  defaultOpen = true,
}: SidebarSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1.5">
      <div className="group flex h-6 items-center gap-1 px-2 text-[11px] font-semibold tracking-wide text-white/50">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 transition-colors hover:text-white/75"
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              open ? "" : "-rotate-90",
            )}
          />
          <span>{title}</span>
        </button>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            title={addLabel}
            className="ml-auto opacity-0 transition-opacity hover:text-white/80 group-hover:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && <div className="mt-0.5 space-y-0.5">{children}</div>}
    </div>
  );
}
