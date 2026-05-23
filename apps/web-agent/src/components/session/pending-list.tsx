"use client";

import { Pencil, Trash2 } from "lucide-react";
import type { TimelineMessage } from "./message-list";

interface PendingListProps {
  messages: TimelineMessage[];
  /** 占位回调：后端 DELETE /pending-messages 落地前先提示「即将支持」。 */
  onDelete?: (id: string) => void;
  /** 占位回调：编辑能力上线前先提示「即将支持」。 */
  onEdit?: (id: string) => void;
}

/**
 * 待处理用户消息列表。渲染在 ChatInput 上方，区别于聊天区气泡。
 *
 * 纯文本一行 + 右侧两个操作按钮位（删除 / 编辑）。
 * 仅在 status === "pending"（服务端未开始调 LLM）的消息进入；
 * 一旦进入 processing 即从这里移除，作为正常 user 气泡显示在聊天区。
 */
export function PendingList({ messages, onDelete, onEdit }: PendingListProps) {
  if (messages.length === 0) return null;
  return (
    <ul className="flex flex-col border-t border-border/60">
      {messages.map((m) => (
        <li
          key={m.id}
          className="group flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1.5 text-xs text-muted-foreground"
        >
          <span className="truncate">{m.content}</span>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              aria-label="编辑"
              className="p-1 text-muted-foreground/60 hover:text-foreground"
              onClick={() => onEdit?.(m.id)}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label="删除"
              className="p-1 text-muted-foreground/60 hover:text-destructive"
              onClick={() => onDelete?.(m.id)}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
