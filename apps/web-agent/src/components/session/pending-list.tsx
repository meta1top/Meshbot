"use client";

import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { TimelineMessage } from "./message-list";

interface PendingListProps {
  messages: TimelineMessage[];
  /** 删除回调；async，await 期间该行按钮禁用 + 显示 loading。 */
  onDelete?: (id: string) => Promise<void>;
  /** 编辑回调；async，期间该行按钮禁用 + 显示 loading。 */
  onEdit?: (id: string) => Promise<void>;
}

/**
 * 待处理用户消息列表。渲染在 ChatInput 上方，区别于聊天区气泡。
 *
 * 仅显示 status === "pending"（runner 未认领）的消息。inFlight 期间禁用该行按钮、
 * 删除图标变为转圈，避免重复点击。
 */
export function PendingList({ messages, onDelete, onEdit }: PendingListProps) {
  const t = useTranslations("session");
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());

  const run = async (id: string, fn?: (id: string) => Promise<void>) => {
    if (!fn) return;
    if (inFlight.has(id)) return;
    setInFlight((s) => new Set(s).add(id));
    try {
      await fn(id);
    } finally {
      setInFlight((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  if (messages.length === 0) return null;
  return (
    <ul className="flex flex-col border-t border-border/60">
      {messages.map((m) => {
        const busy = inFlight.has(m.id);
        return (
          <li
            key={m.id}
            className="group flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1.5 text-xs text-muted-foreground"
          >
            <span className="truncate">{m.content}</span>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                aria-label={t("editPending")}
                disabled={busy}
                className="p-1 text-muted-foreground/60 hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground/60"
                onClick={() => run(m.id, onEdit)}
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={t("deletePending")}
                disabled={busy}
                className="p-1 text-muted-foreground/60 hover:text-destructive disabled:opacity-40 disabled:hover:text-muted-foreground/60"
                onClick={() => run(m.id, onDelete)}
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
