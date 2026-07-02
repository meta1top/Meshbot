"use client";

import { cn } from "@meshbot/design";
import { ChevronDown, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useSessionStream } from "@/hooks/use-session-stream";
import {
  isSubagentOpen,
  resolveSubagentStatus,
  resolveSubSessionId,
  type SubagentCollapse,
  subagentTitle,
  toggleSubagentOpen,
} from "@/lib/subagent-card";
import { MessageList, type ToolCallView } from "./message-list";

/**
 * dispatch_subagent 嵌套卡：折叠头（状态点 + 子任务标题 + 状态文案）+ 展开体
 * （子会话实时消息流：第二个 useSessionStream 实例 + MessageList nested 变体）。
 *
 * - 认领：resolveSubSessionId 三路来源；未认领时只显示「启动中」头，不渲染嵌套流。
 * - 折叠：子 run 运行中自动展开、结束自动收起；用户点击后转手动不再自动。
 * - 收起只隐藏展开体 DOM，不卸载流（避免反复退房/重拉历史）；卸载时 hook 自清理。
 */
export function SubagentCard({ tool }: { tool: ToolCallView }) {
  const t = useTranslations("session.subagent");
  const subSessionId = resolveSubSessionId(tool);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const sub = useSessionStream(subSessionId, scrollRef);
  const [collapse, setCollapse] = useState<SubagentCollapse>({ mode: "auto" });
  const childRunning = sub.running || tool.status === "running";
  const open = isSubagentOpen(collapse, childRunning);
  const status =
    subSessionId === null
      ? ("starting" as const)
      : resolveSubagentStatus(tool, sub.running);
  const title = subagentTitle(tool.args) || t("fallbackTitle");
  const active = status === "running" || status === "starting";
  // 子流有新内容且用户停在底部时吸底跟随（同 StreamBodyPre 逻辑）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages 是「内容变化触发器」，内容增长时吸底
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [sub.messages]);
  const dotColor = active
    ? "bg-primary/70"
    : status === "error"
      ? "bg-destructive"
      : "bg-muted-foreground/40";
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-[8px] border border-border">
      <button
        type="button"
        onClick={() => setCollapse((s) => toggleSubagentOpen(s, childRunning))}
        className="group flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        aria-expanded={open}
      >
        <span
          className={cn(
            "inline-block h-2 w-2 shrink-0 rounded-full",
            dotColor,
            active && "animate-pulse",
          )}
        />
        <span className="min-w-0 truncate font-medium text-foreground">
          {title}
        </span>
        <span className="shrink-0 text-muted-foreground/70">{t(status)}</span>
        {active && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/70" />
        )}
        <ChevronDown
          className={cn(
            "ml-auto h-3 w-3 shrink-0 transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && subSessionId && (
        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (el) {
              stickRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
            }
          }}
          className="max-h-96 overflow-y-auto border-t border-border px-3 py-2"
        >
          <MessageList
            nested
            messages={sub.messages}
            sessionId={subSessionId}
            running={sub.running}
            onRegenerateOptimisticCut={() => {}}
          />
        </div>
      )}
    </div>
  );
}
