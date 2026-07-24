import { cn } from "@meshbot/design";
import type { ImMessage } from "@meshbot/types";
import { Copy } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import {
  annotateRows,
  dayLabel,
  formatTime,
  type MessageRowMeta,
} from "./message-rows";

/** 发送者展示信息(由各 app 从自己的数据源解析注入)。 */
export interface ImMessageSender {
  displayName: string;
  initial: string;
  /** 自己发的:行式→绿头像;气泡→靠右绿泡。 */
  isSelf: boolean;
}

export interface ImMessageListLabels {
  today: string;
  yesterday: string;
  /** 仅 rows variant 的复制按钮 aria/title。 */
  copy?: string;
}

export interface ImMessageListProps {
  messages: ImMessage[];
  variant: "rows" | "bubbles";
  /** 分组键:行式 m=>m.senderId、气泡 m=>m.senderType。 */
  groupKey: (m: ImMessage) => string;
  resolveSender: (m: ImMessage) => ImMessageSender;
  /** 渲染正文:web-agent 注入 MarkdownContent、web-main 注入纯文本。 */
  renderContent: (m: ImMessage) => ReactNode;
  labels: ImMessageListLabels;
  /** rows variant 的复制回调(不传则不显复制条)。 */
  onCopy?: (m: ImMessage) => void;
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 统一 IM 消息列表:分组 + 日期分隔共享,布局按 variant 分行式/气泡。纯展示。 */
export function ImMessageList({
  messages,
  variant,
  groupKey,
  resolveSender,
  renderContent,
  labels,
  onCopy,
}: ImMessageListProps) {
  if (messages.length === 0) return null;
  const rows = annotateRows(messages, groupKey);
  return (
    <div
      className={cn(
        "flex flex-col",
        variant === "rows" ? "pb-6" : "gap-0.5 pb-2",
      )}
    >
      {messages.map((m, i) => {
        const meta = rows[i];
        const sender = resolveSender(m);
        return (
          <Fragment key={m.id}>
            {meta.showDayDivider && (
              <DayDivider
                label={dayLabel(m.createdAt, labels.today, labels.yesterday)}
              />
            )}
            {variant === "rows" ? (
              <RowsItem
                m={m}
                meta={meta}
                sender={sender}
                renderContent={renderContent}
                copyLabel={labels.copy}
                onCopy={onCopy}
              />
            ) : (
              <BubbleItem
                m={m}
                meta={meta}
                sender={sender}
                renderContent={renderContent}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function RowsItem({
  m,
  meta,
  sender,
  renderContent,
  copyLabel,
  onCopy,
}: {
  m: ImMessage;
  meta: MessageRowMeta;
  sender: ImMessageSender;
  renderContent: (m: ImMessage) => ReactNode;
  copyLabel?: string;
  onCopy?: (m: ImMessage) => void;
}) {
  return (
    <div
      className={cn(
        "group relative -mx-2 flex gap-3 rounded px-2 py-1.5 hover:bg-muted/40",
        meta.showHeader ? "mt-1.5" : "mt-0",
      )}
    >
      {meta.showHeader ? (
        <div
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[12px] font-semibold text-white",
            sender.isSelf ? "bg-[#16a34a]" : "bg-(--shell-accent)",
          )}
        >
          {sender.initial}
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
              {sender.displayName}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {formatTime(m.createdAt)}
            </span>
          </div>
        )}
        <div className="text-sm leading-relaxed text-foreground">
          {renderContent(m)}
        </div>
      </div>
      {onCopy && (
        <div className="absolute top-1 right-2 z-10 hidden gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs group-hover:flex">
          <button
            type="button"
            onClick={() => onCopy(m)}
            title={copyLabel}
            aria-label={copyLabel}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function BubbleItem({
  m,
  meta,
  sender,
  renderContent,
}: {
  m: ImMessage;
  meta: MessageRowMeta;
  sender: ImMessageSender;
  renderContent: (m: ImMessage) => ReactNode;
}) {
  const onLeft = !sender.isSelf;
  return (
    <div
      className={cn(
        "flex items-end gap-2 px-1",
        onLeft ? "justify-start" : "justify-end",
        meta.showHeader ? "mt-2" : "mt-0.5",
      )}
    >
      {onLeft &&
        (meta.showHeader ? (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-(--shell-accent) text-[12px] font-semibold text-white">
            {sender.initial}
          </div>
        ) : (
          <div className="w-7 shrink-0" />
        ))}
      <div
        className={cn(
          "flex max-w-[68%] min-w-0 flex-col",
          onLeft ? "items-start" : "items-end",
        )}
      >
        {meta.showHeader && (
          <div className="mb-0.5 flex items-baseline gap-1.5 px-1 text-[11px] text-muted-foreground">
            {onLeft && (
              <span className="font-semibold text-foreground">
                {sender.displayName}
              </span>
            )}
            <span>{formatTime(m.createdAt)}</span>
          </div>
        )}
        <div
          className={cn(
            // 圆角档位表收紧后 rounded-2xl=6px，气泡会变成直角矩形；这里是唯一的
            // 聊天气泡语义元素，显式豁免用更大的圆角保留"泡"的观感（视觉统一 spec 允许豁免）。
            "min-w-0 whitespace-pre-wrap break-words rounded-[14px] px-3 py-2 text-sm leading-relaxed",
            onLeft ? "bg-muted text-foreground" : "bg-[#16a34a] text-white",
          )}
        >
          {renderContent(m)}
        </div>
      </div>
    </div>
  );
}
