"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { upsertConversationAtom } from "@/atoms/im";
import { createDm } from "@/rest/im";
import { useMembers } from "@/rest/org";

interface DmPickerProps {
  open: boolean;
  onClose: () => void;
  /** Called with the conversation id once the DM is created/found. */
  onNavigate: (conversationId: string) => void;
}

/**
 * DM 选人对话框。
 * 拉取当前用户所属 org 的成员列表，排除自身，点击即创建或复用 DM 会话。
 */
export function DmPicker({ open, onClose, onNavigate }: DmPickerProps) {
  const t = useTranslations("messages");
  const currentUser = useAtomValue(currentUserAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);

  const orgId = currentUser?.org?.id ?? null;
  const { data: members = [], isLoading } = useMembers(orgId);

  const [pending, setPending] = useState<string | null>(null);

  if (!open) return null;

  const others = members.filter((m) => m.userId !== currentUser?.id);

  async function handleSelect(userId: string) {
    if (pending) return;
    setPending(userId);
    try {
      const conv = await createDm(userId);
      upsertConversation(conv);
      onNavigate(conv.id);
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
      aria-label={t("pickMember")}
    >
      <div className="w-80 rounded-xl bg-(--shell-content) shadow-2xl ring-1 ring-border">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[14px] font-semibold text-foreground">
            {t("pickMember")}
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
          {isLoading && (
            <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">
              {t("loading")}
            </p>
          )}
          {!isLoading && others.length === 0 && (
            <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">
              {t("empty")}
            </p>
          )}
          {others.map((m) => (
            <button
              key={m.userId}
              type="button"
              disabled={pending === m.userId}
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
