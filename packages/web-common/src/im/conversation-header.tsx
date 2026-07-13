"use client";

import type { ChannelMember, ConversationSummary } from "@meshbot/types";
import { Check, Hash, Lock, LogOut, UserPlus, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface ConversationHeaderLabels {
  /** 私信在线圆点 title。 */
  online: string;
  /** 成员列表 popover 标题 / 成员数按钮 title。 */
  privateChannelMembers: string;
  /** 添加成员：对话框标题 / aria-label / 按钮 title。 */
  privateChannelAddMember: string;
  /** 添加成员对话框：候选已耗尽提示。 */
  privateChannelNoMoreMembers: string;
  /** 退出频道：按钮 title / 对话框标题 / aria-label / 确认按钮文案。 */
  privateChannelLeave: string;
  /** 退出确认按钮 pending 态文案。 */
  privateChannelLeaving: string;
  /** 退出确认正文，name 为频道名（web-common 无 next-intl 插值，改为回调）。 */
  privateChannelLeaveConfirm: (name: string) => string;
  /** 通用取消按钮文案。 */
  channelCancel: string;
  /** 通用加载中文案。 */
  loading: string;
}

export interface ConversationHeaderProps {
  /** 当前会话；未就绪（侧栏聚合尚未到达）时传 null，渲染骨架。 */
  conversation: ConversationSummary | null;
  /** 私有频道当前成员列表；非私有频道场景传空数组即可（不会渲染成员控件）。 */
  members: ChannelMember[];
  /** 添加成员对话框候选人：org 成员，已排除自身（组件内部再排除已在频道中的成员）。 */
  memberCandidates: ChannelMember[];
  memberCandidatesLoading?: boolean;
  /** userId → 是否在线，驱动私信场景的在线圆点。 */
  presence: Record<string, boolean>;
  onAddMember: (userId: string) => Promise<void>;
  /** 添加成员对话框即将打开时触发（早于弹层挂载），供调用方按需惰性拉取候选人。 */
  onAddDialogOpen?: () => void;
  onLeave: () => Promise<void>;
  labels: ConversationHeaderLabels;
}

// ─── 成员列表 Popover ─────────────────────────────────────────────────────────

interface MembersPopoverProps {
  members: ChannelMember[];
  labels: ConversationHeaderLabels;
  onClose: () => void;
}

/**
 * 私有频道成员列表浮层（简单列表，无交互）。
 */
function MembersPopover({ members, labels, onClose }: MembersPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  // 点外部关闭
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl bg-(--shell-content) shadow-2xl ring-1 ring-border"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-foreground">
          {labels.privateChannelMembers}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-60 overflow-y-auto p-1">
        {members.map((m) => (
          <div
            key={m.userId}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5"
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] bg-(--shell-accent) text-[11px] font-semibold text-white">
              {m.displayName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium text-foreground">
                {m.displayName}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 添加成员对话框 ────────────────────────────────────────────────────────────

interface AddMemberDialogProps {
  existingMemberIds: Set<string>;
  candidates: ChannelMember[];
  loading?: boolean;
  onAddMember: (userId: string) => Promise<void>;
  onClose: () => void;
  labels: ConversationHeaderLabels;
}

/**
 * 私有频道添加成员对话框。
 * 复用 channel-picker / dm-picker 的成员选择样式，排除已有成员。
 */
function AddMemberDialog({
  existingMemberIds,
  candidates,
  loading = false,
  onAddMember,
  onClose,
  labels,
}: AddMemberDialogProps) {
  const [pending, setPending] = useState<string | null>(null);

  const filtered = candidates.filter((m) => !existingMemberIds.has(m.userId));

  async function handleSelect(userId: string) {
    if (pending) return;
    setPending(userId);
    try {
      await onAddMember(userId);
      onClose();
    } catch {
      // 保留对话框让用户重试
    } finally {
      setPending(null);
    }
  }

  return (
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
      aria-label={labels.privateChannelAddMember}
    >
      <div className="w-80 rounded-xl bg-(--shell-content) shadow-2xl ring-1 ring-border">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[14px] font-semibold text-foreground">
            {labels.privateChannelAddMember}
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
          {!loading && filtered.length === 0 && (
            <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">
              {labels.privateChannelNoMoreMembers}
            </p>
          )}
          {filtered.map((m) => (
            <button
              key={m.userId}
              type="button"
              disabled={pending !== null}
              onClick={() => void handleSelect(m.userId)}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-(--shell-accent) text-[12px] font-semibold text-white">
                {m.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium">{m.displayName}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {m.email}
                </div>
              </div>
              {pending === m.userId && (
                <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 退出确认对话框 ───────────────────────────────────────────────────────────

interface LeaveConfirmDialogProps {
  channelName: string;
  leaving: boolean;
  onConfirm: () => void;
  onClose: () => void;
  labels: ConversationHeaderLabels;
}

/**
 * 退出私有频道二次确认对话框。
 */
function LeaveConfirmDialog({
  channelName,
  leaving,
  onConfirm,
  onClose,
  labels,
}: LeaveConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget && !leaving) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !leaving) onClose();
      }}
      role="dialog"
      aria-modal
      aria-label={labels.privateChannelLeave}
    >
      <div className="w-[340px] rounded-xl bg-(--shell-content) shadow-2xl ring-1 ring-border">
        <div className="border-b border-border px-4 py-3">
          <span className="text-[14px] font-semibold text-foreground">
            {labels.privateChannelLeave}
          </span>
        </div>
        <div className="px-4 py-3 text-[13px] text-muted-foreground">
          {labels.privateChannelLeaveConfirm(channelName)}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={leaving}
            className="rounded-md border border-border px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {labels.channelCancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={leaving}
            className="rounded-md bg-destructive px-3.5 py-1.5 text-[13px] font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {leaving
              ? labels.privateChannelLeaving
              : labels.privateChannelLeave}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 私有频道控件 ─────────────────────────────────────────────────────────────

interface PrivateChannelControlsProps {
  channelName: string;
  members: ChannelMember[];
  memberCandidates: ChannelMember[];
  memberCandidatesLoading?: boolean;
  onAddMember: (userId: string) => Promise<void>;
  onAddDialogOpen?: () => void;
  onLeave: () => Promise<void>;
  labels: ConversationHeaderLabels;
}

/**
 * 私有频道专属控件：成员数/成员列表弹出、添加成员、退出频道。
 * 仅在 conversation.type === "channel" && conversation.visibility === "private" 时渲染。
 */
function PrivateChannelControls({
  channelName,
  members,
  memberCandidates,
  memberCandidatesLoading,
  onAddMember,
  onAddDialogOpen,
  onLeave,
  labels,
}: PrivateChannelControlsProps) {
  const [showMembersPopover, setShowMembersPopover] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const membersButtonRef = useRef<HTMLButtonElement>(null);

  async function handleLeave() {
    if (leaving) return;
    setLeaving(true);
    try {
      await onLeave();
    } catch {
      // 失败则只关闭对话框，让用户重试
    } finally {
      setLeaving(false);
      setShowLeaveDialog(false);
    }
  }

  const existingMemberIds = new Set(members.map((m) => m.userId));

  return (
    <>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* 成员数 + 列表 */}
        <div className="relative">
          <button
            ref={membersButtonRef}
            type="button"
            onClick={() => setShowMembersPopover((v) => !v)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={labels.privateChannelMembers}
          >
            <Users className="h-3.5 w-3.5" />
            <span>{members.length}</span>
          </button>
          {showMembersPopover && (
            <MembersPopover
              members={members}
              labels={labels}
              onClose={() => setShowMembersPopover(false)}
            />
          )}
        </div>

        {/* 添加成员 */}
        <button
          type="button"
          onClick={() => {
            onAddDialogOpen?.();
            setShowAddDialog(true);
          }}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={labels.privateChannelAddMember}
        >
          <UserPlus className="h-4 w-4" />
        </button>

        {/* 退出频道 */}
        <button
          type="button"
          onClick={() => setShowLeaveDialog(true)}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={labels.privateChannelLeave}
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>

      {/* 添加成员对话框 */}
      {showAddDialog && (
        <AddMemberDialog
          existingMemberIds={existingMemberIds}
          candidates={memberCandidates}
          loading={memberCandidatesLoading}
          onAddMember={onAddMember}
          onClose={() => setShowAddDialog(false)}
          labels={labels}
        />
      )}

      {/* 退出确认对话框 */}
      {showLeaveDialog && (
        <LeaveConfirmDialog
          channelName={channelName}
          leaving={leaving}
          onConfirm={() => void handleLeave()}
          onClose={() => setShowLeaveDialog(false)}
          labels={labels}
        />
      )}
    </>
  );
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

/**
 * IM 会话顶部标题栏。
 * 频道：# name；私信：peer.displayName + 在线状态圆点。
 * 私有频道额外显示：成员数 / 添加成员 / 退出频道。
 * 镜像 session-header.tsx 的样式：h-13 + bg-(--shell-content) + border-b。
 * 纯展示 + 弹层 UI 状态；REST / atom 数据由调用方通过 props 注入。
 */
export function ConversationHeader({
  conversation,
  members,
  memberCandidates,
  memberCandidatesLoading,
  presence,
  onAddMember,
  onAddDialogOpen,
  onLeave,
  labels,
}: ConversationHeaderProps) {
  // 会话元数据未就绪时渲染头部骨架（而非 null）：标题栏始终先在位，
  // 标题随侧栏聚合到达后填入，避免「正文先出现、标题后补」。
  if (!conversation) {
    return (
      <div className="shrink-0 bg-(--shell-content)">
        <div className="flex h-13 w-full items-center gap-2 border-b border-border px-4 lg:px-6">
          <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-32 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  const isChannel = conversation.type === "channel";
  const isPrivateChannel = isChannel && conversation.visibility === "private";
  const peerId = conversation.peer?.userId ?? "";
  // peerId 为空字符串（peer 为 null）时，presence[""] 可能误判为在线，
  // 故仅在 peerId 非空时读取在线状态。
  const online = !isChannel && peerId !== "" && (presence[peerId] ?? false);
  const name = isChannel
    ? (conversation.name ?? "")
    : (conversation.peer?.displayName ?? conversation.name ?? "");

  return (
    <div className="shrink-0 bg-(--shell-content)">
      <div className="flex h-13 w-full items-center gap-2 border-b border-border px-4 lg:px-6">
        {isChannel ? (
          isPrivateChannel ? (
            <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${online ? "bg-green-500" : "bg-muted-foreground/40"}`}
            title={online ? labels.online : undefined}
          />
        )}
        <span className="truncate text-[15px] font-semibold text-foreground">
          {name}
        </span>
        {isPrivateChannel && (
          <PrivateChannelControls
            channelName={name}
            members={members}
            memberCandidates={memberCandidates}
            memberCandidatesLoading={memberCandidatesLoading}
            onAddMember={onAddMember}
            onAddDialogOpen={onAddDialogOpen}
            onLeave={onLeave}
            labels={labels}
          />
        )}
      </div>
    </div>
  );
}
