"use client";

import { cn } from "@meshbot/design";
import { ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import type { ToolCallView } from "./message-list";

/**
 * 单次 tool 调用的「时间线事件」式展示。
 *
 * 设计：reasoning 用「左竖条」表示「连续的思考过程」，tool 用「圆点 + 缩进列表项」
 * 表示「离散的可观察事件」，两者视觉语言完全区分。
 *
 * - 左侧 6px 圆点（按状态着色）+ 等宽工具名 + 行内 args 摘要 + 状态徽章；
 * - 默认收起；点击整行展开请求 / 响应分区，向右缩进对齐圆点右侧；
 * - bash 等流式工具运行期间响应区显示 progress，结束后切到 result。
 */
export function ToolCallBlock({ tool }: { tool: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const argsJson = formatJson(tool.args);
  const argsSummary = formatArgsSummary(tool.args);
  const output = tool.progress || tool.result || "";
  const dotColor =
    tool.status === "running"
      ? "bg-primary/70"
      : tool.status === "error"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground/80"
        aria-expanded={open}
      >
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
            dotColor,
          )}
        />
        <span className="font-mono text-foreground/80">{tool.name}</span>
        {argsSummary && (
          <span className="truncate font-mono text-muted-foreground/60">
            ({argsSummary})
          </span>
        )}
        <span className="flex items-center">
          {renderStatusBadge(tool.status)}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3 w-3 shrink-0 opacity-0 transition-all group-hover:opacity-60",
            !open && "-rotate-90",
            open && "opacity-60",
          )}
        />
      </button>
      {open && (
        <div className="mt-1.5 ml-[14px] flex flex-col gap-2">
          <ToolSection label="请求">
            <pre className="overflow-auto whitespace-pre-wrap bg-foreground/3 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
              {argsJson}
            </pre>
          </ToolSection>
          {(output || tool.status === "running") && (
            <ToolSection label="响应">
              {output ? (
                <pre
                  className={cn(
                    "max-h-64 overflow-auto whitespace-pre-wrap bg-foreground/3 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed",
                    tool.status === "error"
                      ? "text-destructive"
                      : "text-foreground/80",
                  )}
                >
                  {output}
                </pre>
              ) : (
                <span className="bg-foreground/3 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground/60">
                  …
                </span>
              )}
            </ToolSection>
          )}
        </div>
      )}
    </div>
  );
}

function ToolSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] text-muted-foreground/60">{label}</div>
      {children}
    </div>
  );
}

function renderStatusBadge(status: ToolCallView["status"]) {
  if (status === "running") {
    return <Loader2 className="h-3 w-3 animate-spin text-primary/70" />;
  }
  if (status === "ok") {
    return <span className="text-foreground/40">✓</span>;
  }
  return <span className="text-destructive">✗</span>;
}

/** 把 args 对象渲染成单行紧凑摘要 `key: "value", k2: 123`，超长截断。 */
function formatArgsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => {
    if (typeof v === "string") return `${k}: "${v}"`;
    if (v === null || ["number", "boolean"].includes(typeof v))
      return `${k}: ${v}`;
    return `${k}: …`;
  });
  const text = parts.join(", ");
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
