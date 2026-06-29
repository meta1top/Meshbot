"use client";

import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { File, Folder, Loader2, MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DriveMoveModal } from "@/components/drive/drive-move-modal";
import type { DriveNode } from "@/rest/drive";
import { useDeleteNode, useRenameNode } from "@/rest/drive";

/**
 * 将字节数格式化为可读字符串。
 * 文件夹（size = 0）返回 "—"。
 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 格式化修改时间，显示相对或绝对日期。 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays} 天前`;

  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface DriveFileListProps {
  /** 节点列表数据。 */
  nodes: DriveNode[];
  /** 加载中状态。 */
  loading?: boolean;
  /** 当前父目录 id（用于 mutation 失效正确的 query key）。 */
  parentId: string | null;
  /** 点击文件夹时的回调。 */
  onEnterFolder: (node: DriveNode) => void;
  /** 点击文件时的预览回调（Task 6 接入，先占位）。 */
  onPreview: (node: DriveNode) => void;
  className?: string;
}

/** 列表骨架占位行。 */
function FileListSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-border/40 px-3 py-2.5 last:border-0"
        >
          <div className="h-4 w-4 animate-pulse rounded bg-foreground/10 shrink-0" />
          <div className="h-3.5 flex-1 animate-pulse rounded bg-foreground/10" />
          <div className="h-3 w-12 animate-pulse rounded bg-foreground/10" />
          <div className="h-3 w-20 animate-pulse rounded bg-foreground/10" />
          <div className="h-5 w-5 animate-pulse rounded bg-foreground/10 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** 重命名小弹窗（portal 挂到 body）。 */
function RenameDialog({
  node,
  open,
  onClose,
  onDone,
  parentId,
}: {
  node: DriveNode;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  parentId: string | null;
}) {
  const t = useTranslations("drive");
  const renameMutation = useRenameNode(parentId);
  const [value, setValue] = useState(node.name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 每次打开时重置
  useEffect(() => {
    if (open) {
      setValue(node.name);
      setError(null);
      // 下一帧聚焦
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [open, node.name]);

  // Esc 关闭
  useEffect(() => {
    if (!open || renameMutation.isPending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, renameMutation.isPending, onClose]);

  if (!open || typeof document === "undefined") return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || trimmed === node.name) {
      onClose();
      return;
    }
    setError(null);
    try {
      await renameMutation.mutateAsync({ id: node.id, name: trimmed });
      onDone();
    } catch {
      setError(t("renameError"));
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t("renameTitle")}
        className="flex w-full max-w-[360px] flex-col gap-3 rounded-lg border border-border bg-background p-5 shadow-xl"
        onSubmit={handleSubmit}
      >
        <div className="text-[15px] font-semibold text-foreground">
          {t("renameTitle")}
        </div>
        <input
          ref={inputRef}
          type="text"
          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={t("renamePlaceholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={renameMutation.isPending}
        />
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={renameMutation.isPending}
          >
            {t("renameCancel")}
          </Button>
          <Button
            type="submit"
            variant="default"
            size="sm"
            disabled={renameMutation.isPending || !value.trim()}
          >
            {renameMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {t("renameConfirm")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** 单行文件/文件夹条目（含 DropdownMenu 操作 + 弹窗）。 */
function FileListRow({
  node,
  parentId,
  onEnterFolder,
  onPreview,
}: {
  node: DriveNode;
  parentId: string | null;
  onEnterFolder: (node: DriveNode) => void;
  onPreview: (node: DriveNode) => void;
}) {
  const t = useTranslations("drive");
  const isFolder = node.type === "folder";
  const isOwner = node.permission === "owner";
  const canEdit = node.permission === "owner" || node.permission === "editor";

  const deleteMutation = useDeleteNode(parentId);

  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function handleRowClick() {
    if (isFolder) {
      onEnterFolder(node);
    } else {
      onPreview(node);
    }
  }

  async function handleDeleteConfirm() {
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(node.id);
      setDeleteOpen(false);
    } catch {
      setDeleteError(t("deleteError"));
    }
  }

  return (
    <>
      <div
        role="row"
        className={cn(
          "group flex items-center gap-3 border-b border-border/40 px-3 py-2.5 last:border-0 transition-colors",
          "hover:bg-muted/50 cursor-pointer select-none",
        )}
        onClick={handleRowClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleRowClick();
          }
        }}
        tabIndex={0}
        aria-label={node.name}
      >
        {/* 类型图标 */}
        {isFolder ? (
          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
        ) : (
          <File className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}

        {/* 名称 */}
        <span
          className={cn(
            "flex-1 truncate text-sm",
            isFolder ? "font-medium" : "text-foreground",
          )}
          title={node.name}
        >
          {node.name}
        </span>

        {/* 大小 */}
        <span className="w-16 text-right text-xs text-muted-foreground shrink-0">
          {isFolder ? "—" : formatBytes(node.sizeBytes)}
        </span>

        {/* 修改时间 */}
        <span className="w-20 text-right text-xs text-muted-foreground shrink-0">
          {formatDate(node.updatedAt)}
        </span>

        {/* 操作菜单：按 permission 显隐菜单项 */}
        <DropdownMenu>
          <DropdownMenuTrigger
            asChild
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={cn(
                "shrink-0 rounded p-0.5 transition-opacity",
                "opacity-0 group-hover:opacity-100 focus:opacity-100",
                "hover:bg-muted text-muted-foreground",
              )}
              aria-label="更多操作"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {/* editor / owner 才能重命名、移动、删除 */}
            {canEdit && (
              <>
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  {t("menuRename")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
                  {t("menuMove")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    setDeleteError(null);
                    setDeleteOpen(true);
                  }}
                  className="text-destructive focus:text-destructive"
                >
                  {t("menuDelete")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {/* 共享仅 owner 可见 */}
            {isOwner && (
              <DropdownMenuItem disabled>{t("menuShare")}</DropdownMenuItem>
            )}
            {/* 下载 / 预览：全部权限可见（Task 6 接入） */}
            <DropdownMenuItem disabled>{t("menuDownload")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 重命名弹窗 */}
      <RenameDialog
        node={node}
        open={renameOpen}
        parentId={parentId}
        onClose={() => setRenameOpen(false)}
        onDone={() => setRenameOpen(false)}
      />

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={deleteOpen}
        title={t("deleteTitle")}
        description={
          <span>
            {isFolder
              ? t("deleteFolderDesc", { name: node.name })
              : t("deleteFileDesc", { name: node.name })}
            {deleteError && (
              <span className="block mt-1 text-destructive text-[12px]">
                {deleteError}
              </span>
            )}
          </span>
        }
        confirmText={t("deleteConfirm")}
        cancelText={t("deleteCancel")}
        destructive
        loading={deleteMutation.isPending}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteOpen(false)}
      />

      {/* 移动弹窗 */}
      <DriveMoveModal
        node={node}
        fromParentId={parentId}
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
      />
    </>
  );
}

/**
 * 网盘文件列表：展示节点列表，支持进入文件夹与文件预览。
 * loading 时显示骨架占位；空列表显示空态提示。
 */
export function DriveFileList({
  nodes,
  loading = false,
  parentId,
  onEnterFolder,
  onPreview,
  className,
}: DriveFileListProps) {
  const t = useTranslations("drive");

  if (loading) {
    return <FileListSkeleton />;
  }

  if (nodes.length === 0) {
    return (
      <div className={cn("flex flex-col items-center gap-2 py-16", className)}>
        <Folder className="h-10 w-10 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">{t("emptyHint")}</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border overflow-hidden",
        className,
      )}
      role="table"
      aria-label={t("fileListLabel")}
    >
      {/* 表头 */}
      <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="w-4 shrink-0" />
        <span className="flex-1">{t("colName")}</span>
        <span className="w-16 text-right shrink-0">{t("colSize")}</span>
        <span className="w-20 text-right shrink-0">{t("colModified")}</span>
        <span className="w-5 shrink-0" />
      </div>

      {/* 文件/文件夹行列表 */}
      {nodes.map((node) => (
        <FileListRow
          key={node.id}
          node={node}
          parentId={parentId}
          onEnterFolder={onEnterFolder}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}
