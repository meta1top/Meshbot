"use client";

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { File, Folder, MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import type { DriveNode } from "@/rest/drive";

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

/** 单行文件/文件夹条目。 */
function FileListRow({
  node,
  onEnterFolder,
  onPreview,
}: {
  node: DriveNode;
  onEnterFolder: (node: DriveNode) => void;
  onPreview: (node: DriveNode) => void;
}) {
  const isFolder = node.type === "folder";

  function handleRowClick() {
    if (isFolder) {
      onEnterFolder(node);
    } else {
      onPreview(node);
    }
  }

  return (
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

      {/* 操作菜单占位（Task 5 接入） */}
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
          <DropdownMenuItem disabled>重命名（即将上线）</DropdownMenuItem>
          <DropdownMenuItem disabled>移动（即将上线）</DropdownMenuItem>
          <DropdownMenuItem disabled className="text-destructive">
            删除（即将上线）
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * 网盘文件列表：展示节点列表，支持进入文件夹与文件预览。
 * loading 时显示骨架占位；空列表显示空态提示。
 */
export function DriveFileList({
  nodes,
  loading = false,
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
          onEnterFolder={onEnterFolder}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}
