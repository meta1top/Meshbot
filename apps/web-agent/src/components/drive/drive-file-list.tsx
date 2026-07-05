"use client";

import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@meshbot/design";
import { useSetAtom } from "jotai";
import {
  ArrowDown,
  ArrowUp,
  Folder,
  Loader2,
  MoreHorizontal,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DriveMoveModal } from "@/components/drive/drive-move-modal";
import { DriveShareLinkModal } from "@/components/drive/drive-share-link-modal";
import { DriveShareModal } from "@/components/drive/drive-share-modal";
import { driveFileIcon } from "@/lib/drive-file-icon";
import { type SortDir, type SortKey, sortNodes } from "@/lib/sort-nodes";
import type { DriveNode } from "@/rest/drive";
import { getFileUrl, useDeleteNode, useRenameNode } from "@/rest/drive";

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
  /** 只读模式：隐藏重命名/移动/删除/共享等写操作，仅保留预览/下载。 */
  readOnly?: boolean;
  className?: string;
}

/** 列表骨架占位行。 */
function FileListSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-md border border-border"
      aria-hidden
    >
      <Table>
        <TableBody>
          {[0, 1, 2, 3, 4].map((i) => (
            <TableRow key={i}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-foreground/10" />
                  <div className="h-3.5 w-40 animate-pulse rounded bg-foreground/10" />
                </div>
              </TableCell>
              <TableCell className="w-24 text-right">
                <div className="ml-auto h-3 w-12 animate-pulse rounded bg-foreground/10" />
              </TableCell>
              <TableCell className="w-32 text-right">
                <div className="ml-auto h-3 w-20 animate-pulse rounded bg-foreground/10" />
              </TableCell>
              <TableCell className="w-10" />
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
  readOnly = false,
}: {
  node: DriveNode;
  parentId: string | null;
  onEnterFolder: (node: DriveNode) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations("drive");
  const isFolder = node.type === "folder";
  const isOwner = node.permission === "owner";
  const canEdit = node.permission === "owner" || node.permission === "editor";

  const setPreviewArtifact = useSetAtom(previewArtifactAtom);

  const deleteMutation = useDeleteNode(parentId);

  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** 拿 presigned URL 后打开 dock 预览。 */
  async function handlePreview() {
    const { url } = await getFileUrl(node.id);
    setPreviewArtifact({ url, name: node.name });
  }

  function handleRowClick() {
    if (isFolder) {
      onEnterFolder(node);
    } else {
      void handlePreview();
    }
  }

  /** 拿 presigned URL 后 fetch blob，确保跨域 download 属性生效。 */
  async function handleDownload() {
    const { url } = await getFileUrl(node.id);
    const res = await fetch(url);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = node.name;
    a.click();
    URL.revokeObjectURL(objUrl);
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

  const { Icon, colorClass } = driveFileIcon(node.name, node.type);

  return (
    <>
      <TableRow
        className="group cursor-pointer select-none"
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
        {/* 图标 + 名称 */}
        <TableCell className="max-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Icon className={cn("h-4 w-4 shrink-0", colorClass)} />
            <span
              className={cn("truncate", isFolder && "font-medium")}
              title={node.name}
            >
              {node.name}
            </span>
          </div>
        </TableCell>

        {/* 大小 */}
        <TableCell className="w-24 text-right text-[12px] text-muted-foreground">
          {isFolder ? "—" : formatBytes(node.sizeBytes)}
        </TableCell>

        {/* 修改时间 */}
        <TableCell className="w-32 text-right text-[12px] text-muted-foreground">
          {formatDate(node.updatedAt)}
        </TableCell>

        {/* 操作菜单：按 permission 显隐菜单项 */}
        <TableCell className="w-10 text-right">
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
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
            >
              {/* editor / owner 才能重命名、移动、删除；只读模式下隐藏 */}
              {canEdit && !readOnly && (
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
              {/* 共享仅 owner 可见；只读模式下隐藏 */}
              {isOwner && !readOnly && (
                <DropdownMenuItem onSelect={() => setShareOpen(true)}>
                  {t("menuShare")}
                </DropdownMenuItem>
              )}
              {/* 公开链接仅 owner 且 file 行可见；只读模式下隐藏 */}
              {isOwner && !readOnly && !isFolder && (
                <DropdownMenuItem onSelect={() => setShareLinkOpen(true)}>
                  {t("menuShareLink")}
                </DropdownMenuItem>
              )}
              {/* 下载 / 预览：仅文件可用，所有权限可见 */}
              {!isFolder && (
                <>
                  <DropdownMenuItem onSelect={() => void handlePreview()}>
                    {t("menuPreview")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleDownload()}>
                    {t("menuDownload")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>

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

      {/* 共享设置弹窗（仅 owner） */}
      {isOwner && (
        <DriveShareModal
          nodeId={node.id}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* 公开链接弹窗（仅 owner 且 file 行） */}
      {isOwner && !isFolder && (
        <DriveShareLinkModal
          nodeId={node.id}
          open={shareLinkOpen}
          onClose={() => setShareLinkOpen(false)}
        />
      )}
    </>
  );
}

/** 可排序列头按钮：标题 + 当前排序方向箭头（右对齐列箭头在左）。 */
function SortHead({
  label,
  active,
  dir,
  align,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  align?: "right";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 transition-colors hover:text-foreground",
        align === "right" && "flex-row-reverse",
      )}
    >
      {label}
      {active &&
        (dir === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        ))}
    </button>
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
  readOnly = false,
  className,
}: DriveFileListProps) {
  const t = useTranslations("drive");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

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

  const sorted = sortNodes(nodes, sortKey, sortDir);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border",
        className,
      )}
    >
      <Table aria-label={t("fileListLabel")}>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>
              <SortHead
                label={t("colName")}
                active={sortKey === "name"}
                dir={sortDir}
                onClick={() => toggleSort("name")}
              />
            </TableHead>
            <TableHead className="w-24 text-right">
              <SortHead
                label={t("colSize")}
                active={sortKey === "size"}
                dir={sortDir}
                align="right"
                onClick={() => toggleSort("size")}
              />
            </TableHead>
            <TableHead className="w-32 text-right">
              <SortHead
                label={t("colModified")}
                active={sortKey === "modified"}
                dir={sortDir}
                align="right"
                onClick={() => toggleSort("modified")}
              />
            </TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((node) => (
            <FileListRow
              key={node.id}
              node={node}
              parentId={parentId}
              onEnterFolder={onEnterFolder}
              readOnly={readOnly}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
