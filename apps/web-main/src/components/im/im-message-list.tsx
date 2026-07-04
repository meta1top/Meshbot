"use client";

import { cn } from "@meshbot/design";
import type { ImMessage } from "@meshbot/types";
import { useTranslations } from "next-intl";
import { Fragment } from "react";

interface ImMessageListProps {
  messages: ImMessage[];
  /** 设备 Agent 显示名（会话 peer.displayName），用于头像首字母与消息头名字。 */
  agentName: string;
}

/** ISO → HH:MM（24h，显式 locale + hour12，避免环境 locale 不一致导致格式漂移）。 */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 本地日历日 key（按本地年-月-日）。 */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 日期分隔标签：今天 / 昨天 / 本地日期（不依赖环境 locale，web/desktop 一致）。 */
function dayLabel(iso: string, today: string, yesterday: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(d, now)) return today;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (isSameDay(d, y)) return yesterday;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

interface RowMeta {
  showDayDivider: boolean;
  showHeader: boolean;
}

/** 标注每行分组元信息：跨天或换发送者类型 → 显示头（名字+时间），否则并入上一组。 */
function annotateRows(messages: ImMessage[]): RowMeta[] {
  let prevDay = "";
  let prevType = "";
  return messages.map((m) => {
    const dk = dayKey(m.createdAt);
    const showDayDivider = dk !== prevDay;
    const showHeader = showDayDivider || m.senderType !== prevType;
    prevDay = dk;
    prevType = m.senderType;
    return { showDayDivider, showHeader };
  });
}

/**
 * Agent-DM 消息列表：按 `senderType` 分左右——'agent' 左侧（设备名 + 头像首字母），
 * 'user' 右侧（自己，绿色气泡，无头像）。连续同类型消息分组，仅首条显头（名字+时间），
 * 跨天插日期分隔条。纯展示组件，MVP 纯文本渲染（不解析 markdown）。
 */
export function ImMessageList({ messages, agentName }: ImMessageListProps) {
  const t = useTranslations("imConversation");
  if (messages.length === 0) return null;

  const rows = annotateRows(messages);
  const agentInitial = agentName.trim().charAt(0).toUpperCase() || "A";

  return (
    <div className="flex flex-col gap-0.5 pb-2">
      {messages.map((m, i) => {
        const meta = rows[i];
        const isAgent = m.senderType === "agent";

        return (
          <Fragment key={m.id}>
            {meta.showDayDivider && (
              <div className="my-3 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {dayLabel(m.createdAt, t("today"), t("yesterday"))}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}

            <div
              className={cn(
                "flex items-end gap-2 px-1",
                isAgent ? "justify-start" : "justify-end",
                meta.showHeader ? "mt-2" : "mt-0.5",
              )}
            >
              {isAgent &&
                (meta.showHeader ? (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-(--shell-accent) text-[12px] font-semibold text-white">
                    {agentInitial}
                  </div>
                ) : (
                  <div className="w-7 shrink-0" />
                ))}

              <div
                className={cn(
                  "flex max-w-[68%] min-w-0 flex-col",
                  isAgent ? "items-start" : "items-end",
                )}
              >
                {meta.showHeader && (
                  <div className="mb-0.5 flex items-baseline gap-1.5 px-1 text-[11px] text-muted-foreground">
                    {isAgent && (
                      <span className="font-semibold text-foreground">
                        {agentName}
                      </span>
                    )}
                    <span>{formatTime(m.createdAt)}</span>
                  </div>
                )}
                <div
                  className={cn(
                    "min-w-0 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed",
                    isAgent
                      ? "bg-muted text-foreground"
                      : "bg-[#16a34a] text-white",
                  )}
                >
                  {m.content}
                </div>
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
