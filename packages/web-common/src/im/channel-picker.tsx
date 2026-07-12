"use client";

import type { ChannelMember } from "@meshbot/types";
import { Check, Lock, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

export interface ChannelPickerLabels {
  title: string;
  nameLabel: string;
  namePlaceholder: string;
  visibilityLabel: string;
  visibilityPublic: string;
  visibilityPrivate: string;
  initialMembers: string;
  noMembers: string;
  loading: string;
  cancel: string;
  create: string;
  creating: string;
}

export interface CreateChannelInput {
  name: string;
  visibility: "public" | "private";
  /** 仅 private 时可能非空。 */
  memberIds?: string[];
}

export interface ChannelPickerProps {
  /** 初始成员候选人：org 成员，已排除自身；仅 visibility=private 时渲染多选列表。 */
  candidates: ChannelMember[];
  loading?: boolean;
  /** 提交创建：由调用方发起 REST + 会话列表更新 + 导航。抛错则表单保留内容供用户重试。 */
  onCreate: (input: CreateChannelInput) => Promise<void>;
  onClose: () => void;
  labels: ChannelPickerLabels;
}

/**
 * 创建频道弹框。
 * - 公开频道：仅需填写频道名称
 * - 私有频道：额外展示 org 成员多选（排除自身，可选 0 至 N 人作为初始成员）
 * 纯表单 UI + 提交态；调用方仅在需要展示时挂载本组件（无内建 open 开关）。
 */
export function ChannelPicker({
  candidates,
  loading = false,
  onCreate,
  onClose,
  labels,
}: ChannelPickerProps) {
  const [channelName, setChannelName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // 挂载即聚焦名称输入框（调用方仅在弹框打开时才挂载本组件）。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
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
      await onCreate({ name, visibility, memberIds });
      handleClose();
    } catch {
      // 保留表单内容，让用户重试
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

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
      aria-label={labels.title}
    >
      <div className="w-[360px] rounded-xl bg-(--shell-content) shadow-2xl ring-1 ring-border">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[14px] font-semibold text-foreground">
            {labels.title}
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
              {labels.nameLabel}
            </label>
            <input
              ref={inputRef}
              id="channel-name"
              type="text"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder={labels.namePlaceholder}
              autoComplete="off"
              disabled={submitting}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            />
          </div>

          {/* Visibility toggle */}
          <div className="mb-4">
            <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
              {labels.visibilityLabel}
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
                {labels.visibilityPublic}
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
                {labels.visibilityPrivate}
              </button>
            </div>
          </div>

          {/* Member multi-select（仅私有频道显示） */}
          {visibility === "private" && (
            <div className="mb-4">
              <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                {labels.initialMembers}
              </span>
              <div className="max-h-52 overflow-y-auto rounded-md border border-border bg-background">
                {loading && (
                  <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">
                    {labels.loading}
                  </p>
                )}
                {!loading && candidates.length === 0 && (
                  <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">
                    {labels.noMembers}
                  </p>
                )}
                {candidates.map((m) => {
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
              {labels.cancel}
            </button>
            <button
              type="submit"
              disabled={submitting || !channelName.trim()}
              className="rounded-md bg-(--shell-accent) px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-(--shell-accent-hover) disabled:opacity-50"
            >
              {submitting ? labels.creating : labels.create}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
