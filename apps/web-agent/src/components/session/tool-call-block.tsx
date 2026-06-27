"use client";

import { cn } from "@meshbot/design";
import type { TodoItem } from "@meshbot/types-agent";
import {
  extractPartialString,
  parsePartialToolArgs,
} from "@meshbot/web-common";
import { ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import { ImSendConfirmCard } from "./im-send-confirm-card";
import type { ToolCallView } from "./message-list";
import { TodoList } from "./todo-list";

/**
 * 单次 tool 调用的「时间线事件」式展示。
 *
 * 设计：reasoning 用「左竖条」表示「连续的思考过程」，tool 用「圆点 + 缩进列表项」
 * 表示「离散的可观察事件」，两者视觉语言完全区分。
 *
 * - 左侧 6px 圆点（按状态着色）+ 等宽工具名 + 行内 args 摘要 + 状态徽章；
 * - 默认收起；点击整行展开请求 / 响应分区，向右缩进对齐圆点右侧；
 * - bash 等流式工具运行期间响应区显示 progress，结束后切到 result。
 *
 * 同一个块按 toolCallId 贯穿三态：streaming（LLM 仍在打字生成参数）→ running
 * （执行中）→ ok/error（完成）。streaming 阶段 args 未定稿，用 argsText 尽力部分
 * 解析出行内摘要 + write/edit/bash 的正文打字预览；不再先建独立预览块再清空。
 */
export function ToolCallBlock({
  tool,
  sessionId,
}: {
  tool: ToolCallView;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  if (tool.name === "im_send_message" && tool.status !== "streaming") {
    return <ImSendConfirmCard tool={tool} sessionId={sessionId} />;
  }
  if (tool.name === "todo_write" && tool.status !== "streaming") {
    const todos = ((tool.args ?? {}) as { todos?: TodoItem[] }).todos ?? [];
    return (
      <div className="flex w-full flex-col gap-1.5 rounded-[8px] border border-border bg-muted/30 px-3 py-2">
        <div className="text-xs font-medium text-muted-foreground">
          待办清单
        </div>
        <TodoList todos={todos} />
      </div>
    );
  }
  const streaming = tool.status === "streaming";
  // streaming 阶段权威 args 还没到，用累积的 argsText 尽力部分解析。
  const displayArgs =
    tool.args !== undefined
      ? tool.args
      : tool.argsText
        ? parsePartialToolArgs(tool.argsText)
        : undefined;
  const argsJson = formatJson(displayArgs);
  const argsSummary = formatArgsSummary(displayArgs);
  // 文件写入 / bash 等有「正文」的工具：流式阶段逐字预览正文（打字效果）。
  const streamBody = streaming
    ? extractPartialString(tool.argsText ?? "", "command") ||
      extractPartialString(tool.argsText ?? "", "content") ||
      extractPartialString(tool.argsText ?? "", "new_string")
    : "";
  const output = tool.progress || tool.result || "";
  const { server, name: displayName } = parseToolName(tool.name);
  const dotColor =
    tool.status === "running" || streaming
      ? "bg-primary/70"
      : tool.status === "error"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
  return (
    <div className="flex w-full flex-col rounded-[8px] border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        aria-expanded={open}
      >
        <span
          className={cn(
            "inline-block h-2 w-2 shrink-0 rounded-full",
            dotColor,
            streaming && "animate-pulse",
          )}
        />
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap font-mono">
          {server && (
            <>
              <span className="text-muted-foreground">{server}</span>
              <span className="text-muted-foreground/50">/</span>
            </>
          )}
          <span className="text-foreground">{displayName}</span>
        </span>
        {argsSummary && (
          <span className="min-w-0 truncate font-mono text-muted-foreground/70">
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
      {streamBody && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground">
          {streamBody}
          <span className="animate-pulse">▋</span>
        </pre>
      )}
      {open && (
        <div className="flex flex-col gap-3 px-2.5 py-2">
          <ToolSection label="请求">
            <pre className="overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground">
              {argsJson}
            </pre>
          </ToolSection>
          {(output || tool.status === "running") && (
            <ToolSection label="响应">
              {output ? (
                <pre
                  className={cn(
                    "max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed",
                    tool.status === "error"
                      ? "text-destructive"
                      : "text-foreground",
                  )}
                >
                  {output}
                </pre>
              ) : (
                <span className="font-mono text-[11px] text-muted-foreground">
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
    <div className="flex flex-col gap-1">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function renderStatusBadge(status: ToolCallView["status"]) {
  if (status === "running" || status === "streaming") {
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

/**
 * 把 `mcp__<server>__<tool>` 拆成 `{ server, name }`，方便分两段渲染；
 * 内建工具（无 `mcp__` 前缀）返 `{ server: null, name: tool.name }`。
 *
 * 用 non-greedy + 第一个 `__` 分割：server 取一段（如 `chrome-devtools`），
 * 余下整体视为 tool name（哪怕里面再含 `__` 也保留）。
 */
function parseToolName(raw: string): { server: string | null; name: string } {
  const m = raw.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return { server: null, name: raw };
  return { server: m[1], name: m[2] };
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
