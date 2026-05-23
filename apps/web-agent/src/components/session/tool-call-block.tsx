"use client";

import { cn } from "@meshbot/design";
import { ChevronRight, Loader2, Wrench } from "lucide-react";
import { useState } from "react";
import type { ToolCallView } from "./message-list";

/**
 * 单次 tool 调用的折叠展示块。
 *
 * 标签：「🔧 bash · running」/「🔧 bash ✓」/「🔧 bash ✗」
 * 展开：args（JSON）+ progress（实时累积，pre 元素）+ result（最终）
 * 风格仿 ReasoningBlock：左侧细竖线 + 等宽小字 + 无背景。
 */
export function ToolCallBlock({ tool }: { tool: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const statusBadge =
    tool.status === "running" ? (
      <Loader2 className="h-3 w-3 animate-spin" />
    ) : tool.status === "ok" ? (
      <span className="text-foreground/60">✓</span>
    ) : (
      <span className="text-destructive">✗</span>
    );
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 self-start text-xs text-muted-foreground/80 hover:text-muted-foreground"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
        />
        <Wrench className="h-3 w-3" />
        <span>{tool.name}</span>
        {statusBadge}
      </button>
      {open && (
        <div className="flex flex-col gap-1 border-l-2 border-border/60 pl-3 text-[12px] text-muted-foreground/80">
          <div>
            <span className="text-muted-foreground/60">args:</span>{" "}
            <code className="font-mono text-[11px]">
              {JSON.stringify(tool.args)}
            </code>
          </div>
          {tool.progress && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
              {tool.progress}
            </pre>
          )}
          {tool.result && tool.status !== "running" && !tool.progress && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
              {tool.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
