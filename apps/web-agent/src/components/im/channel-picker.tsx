"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Check, Lock, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { upsertConversationAtom } from "@/atoms/im";
import { createChannel } from "@/rest/im";
import { useMembers } from "@/rest/org";

interface ChannelPickerProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功后导航到新频道 */
  onNavigate: (conversationId: string) => void;
}

/**
 * 创建频道弹框。
 * - 公开频道：仅需填写频道名称
 * - 私有频道：额外展示 org 成员多选（排除自身，可选 0 至 N 人作为初始成员）
 */
export function ChannelPicker({
  open,
  onClose,
  onNavigate,
}: ChannelPickerProps) {
  const t = useTranslations("messages");
  const currentUser = useAtomValue(currentUserAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);

  const orgId = currentUser?.org?.id ?? null;
  const { data: members = [], isLoading } = useMembers(orgId);

  const [channelName, setChannelName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // 弹框打开时聚焦名称输入框
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  // 排除自身
  const others = currentUser
    ? members.filter((m) => m.userId !== currentUser.id)
    : [];

  function resetForm() {
    setChannelName("");
    setVisibility("public");
    setSelectedIds(new Set());
    setSubmitting(false);
    submittingRef.current = false;
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  function toggleMember(userId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    const name = channelName.trim();
    if (!name) {
      inputRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const memberIds =
        visibility === "private" ? Array.from(selectedIds) : undefined;
      const conv = await createChannel(name, visibility, memberIds);
      upsertConversation(conv);
      onNavigate(conv.id);
      handleClose();
    } catch {
      // 保留表单内容，让用户重试
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") handleClose();
      }}
      role="dialog"
      aria-modal
      aria-label={t("newChannel")}
    >
      <div className="w-[360px] rounded-xl bg-(--shell-content) shadow-2xl ring-1 ring-border">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[14px] font-semibold text-foreground">
            {t("newChannel")}
          </span>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={(e) => void handleSubmit(e)} className="p-4">
          {/* Channel name */}
          <div className="mb-4">
            <label
              htmlFor="channel-name"
              className="mb-1.5 block text-[12px] font-medium text-muted-foreground"
            >
              {t("channelNameLabel")}
            </label>
            <input
              ref={inputRef}
              id="channel-name"
              type="text"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder={t("channelNamePlaceholder")}
              autoComplete="off"
              disabled={submitting}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            />
          </div>

          {/* Visibility toggle */}
          <div className="mb-4">
            <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
              {t("channelVisibilityLabel")}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setVisibility("public")}
                disabled={submitting}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[13px] transition-colors disabled:opacity-50 ${
                  visibility === "public"
                    ? "border-ring bg-muted font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {t("channelVisibilityPublic")}
              </button>
              <button
                type="button"
                onClick={() => setVisibility("private")}
                disabled={submitting}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[13px] transition-colors disabled:opacity-50 ${
                  visibility === "private"
                    ? "border-ring bg-muted font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <Lock className="h-3 w-3" />
                {t("channelVisibilityPrivate")}
              </button>
            </div>
          </div>

          {/* Member multi-select（仅私有频道显示） */}
          {visibility === "private" && (
            <div className="mb-4">
              <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                {t("channelInitialMembers")}
              </span>
              <div className="max-h-52 overflow-y-auto rounded-md border border-border bg-background">
                {isLoading && (
                  <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">
                    {t("loading")}
                  </p>
                )}
                {!isLoading && others.length === 0 && (
                  <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">
                    {t("channelNoMembers")}
                  </p>
                )}
                {others.map((m) => {
                  const selected = selectedIds.has(m.userId);
                  return (
                    <button
                      key={m.userId}
                      type="button"
                      disabled={submitting}
                      onClick={() => toggleMember(m.userId)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      {/* Checkbox visual */}
                      <div
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                          selected
                            ? "border-transparent bg-(--shell-accent)"
                            : "border-border bg-background"
                        }`}
                      >
                        {selected && (
                          <Check className="h-2.5 w-2.5 text-white" />
                        )}
                      </div>
                      {/* Avatar initial */}
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-(--shell-accent) text-[12px] font-semibold text-white">
                        {m.displayName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">
                          {m.displayName}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {m.email}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="rounded-md border border-border px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {t("channelCancel")}
            </button>
            <button
              type="submit"
              disabled={submitting || !channelName.trim()}
              className="rounded-md bg-(--shell-accent) px-3.5 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? t("channelCreating") : t("channelCreate")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
