"use client";

import type { ChannelMember } from "@meshbot/types";
import { X } from "lucide-react";
import { useState } from "react";

export interface DmPickerLabels {
  /** 弹框标题 / aria-label。 */
  title: string;
  loading: string;
  /** 候选人为空提示。 */
  empty: string;
}

export interface DmPickerProps {
  /** 候选人：org 成员，已排除自身。 */
  candidates: ChannelMember[];
  loading?: boolean;
  /** 选中某成员：由调用方发起创建/复用 DM + 会话列表更新 + 导航。抛错可重试。 */
  onPick: (userId: string) => Promise<void>;
  onClose: () => void;
  labels: DmPickerLabels;
}

/**
 * DM 选人对话框。
 * 展示候选人列表，点击即触发调用方的创建/复用 DM 会话逻辑。
 * 纯展示 + pending 态；调用方仅在需要展示时挂载本组件（无内建 open 开关）。
 */
export function DmPicker({
  candidates,
  loading = false,
  onPick,
  onClose,
  labels,
}: DmPickerProps) {
  const [pending, setPending] = useState<string | null>(null);

  async function handleSelect(userId: string) {
    if (pending) return;
    setPending(userId);
    try {
      await onPick(userId);
      onClose();
    } catch {
      // swallow — user can retry
    } finally {
      setPending(null);
    }
  }

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="dialog"
      aria-modal
      aria-label={labels.title}
    >
      <div className="w-80 rounded-xl bg-(--shell-content) shadow-2xl ring-1 ring-border">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[14px] font-semibold text-foreground">
            {labels.title}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Member list */}
        <div className="max-h-72 overflow-y-auto p-2">
          {loading && (
            <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">
              {labels.loading}
            </p>
          )}
          {!loading && candidates.length === 0 && (
            <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">
              {labels.empty}
            </p>
          )}
          {candidates.map((m) => (
            <button
              key={m.userId}
              type="button"
              disabled={pending !== null}
              onClick={() => void handleSelect(m.userId)}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {/* Avatar initial */}
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-(--shell-accent) text-[12px] font-semibold text-white">
                {m.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium">{m.displayName}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {m.email}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
