import { cn } from "@meshbot/design";
import type { ImMessage } from "@meshbot/types";
import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { annotateRows } from "@/lib/message-rows";

interface ImMessageListProps {
  messages: ImMessage[];
  /** userId → sender info, for name and avatar initial */
  members: Record<string, { displayName: string; email: string }>;
  /** current user's id — own messages get a green avatar */
  currentUserId: string;
}

/** ISO → HH:MM（24h，显式 locale + hour12，避免 web/desktop 因环境 locale 不一致）。 */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 同一本地日历日。 */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 日期分隔标签：今天 / 昨天 / 本地日期。 */
function dayLabel(iso: string, today: string, yesterday: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(d, now)) return today;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (isSameDay(d, y)) return yesterday;
  // 固定 YYYY-MM-DD（不依赖环境 locale），web/desktop 一致。
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * IM 消息列表（Slack 行式 + 精修）：消息分组（连续同发送者仅首条显头像+名字，
 * 后续行 hover 在左 gutter 显时间）+ 日期分隔条 + hover 复制。纯展示组件。
 */
export function ImMessageList({
  messages,
  members,
  currentUserId,
}: ImMessageListProps) {
  const t = useTranslations("messages");
  if (messages.length === 0) return null;

  const rows = annotateRows(messages);

  return (
    <div className="flex flex-col pb-6">
      {messages.map((m, i) => {
        const meta = rows[i];
        const sender = members[m.senderId];
        const displayName = sender?.displayName ?? m.senderId;
        const initial = displayName.charAt(0).toUpperCase();
        const isSelf = m.senderId === currentUserId;

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
                "group relative -mx-2 flex gap-3 rounded px-2 py-1.5 hover:bg-muted/40",
                meta.showHeader ? "mt-1.5" : "mt-0",
              )}
            >
              {/* 左 gutter：头行=头像；分组行=hover 时间 */}
              {meta.showHeader ? (
                <div
                  className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[12px] font-semibold text-white",
                    isSelf ? "bg-[#16a34a]" : "bg-(--shell-accent)",
                  )}
                >
                  {initial}
                </div>
              ) : (
                <div className="w-7 shrink-0 pt-0.5 text-right text-[9px] leading-5 text-muted-foreground opacity-0 group-hover:opacity-100">
                  {formatTime(m.createdAt)}
                </div>
              )}

              <div className="min-w-0 flex-1">
                {meta.showHeader && (
                  <div className="mb-0.5 flex items-baseline gap-2">
                    <span className="text-[13px] font-bold text-foreground">
                      {displayName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatTime(m.createdAt)}
                    </span>
                  </div>
                )}
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {m.content}
                </div>
              </div>

              {/* hover 操作条：复制（功能性）。表情/回复/收藏待后端，后续计划。 */}
              <div className="absolute top-1 right-2 z-10 hidden gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs group-hover:flex">
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(m.content)}
                  title={t("copy")}
                  aria-label={t("copy")}
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
