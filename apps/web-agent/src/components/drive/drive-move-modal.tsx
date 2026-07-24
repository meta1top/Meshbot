"use client";

import { Button } from "@meshbot/design";
import { ChevronRight, Folder, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { type DriveNode, useDriveNodes, useMoveNode } from "@/rest/drive";

interface BreadcrumbEntry {
  id: string | null;
  name: string;
}

interface DriveMoveModalProps {
  /** 被移动的节点（需要过滤掉自身）。 */
  node: DriveNode;
  /** 当前所在父目录 id（用于 onSuccess 失效）。 */
  fromParentId: string | null;
  open: boolean;
  onClose: () => void;
}

/** 弹窗内文件夹浏览器（仅显示文件夹行）。 */
function FolderBrowser({
  browsedParentId,
  excludeId,
  onEnter,
}: {
  browsedParentId: string | null;
  excludeId: string;
  onEnter: (node: DriveNode) => void;
}) {
  const t = useTranslations("drive");
  const { data: nodes = [], isLoading } = useDriveNodes(browsedParentId);
  const folders = nodes.filter(
    (n) => n.type === "folder" && n.id !== excludeId,
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (folders.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        {t("noSubFolders")}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {folders.map((folder) => (
        <button
          key={folder.id}
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted/60 transition-colors text-left"
          onClick={() => onEnter(folder)}
        >
          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="flex-1 truncate">{folder.name}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

/**
 * 移动节点弹窗：逐级浏览文件夹，选定目标后调用 moveNode。
 * 不能移到自身（前端过滤）；后端有 DRIVE_INVALID_MOVE 兜底。
 */
export function DriveMoveModal({
  node,
  fromParentId,
  open,
  onClose,
}: DriveMoveModalProps) {
  const t = useTranslations("drive");
  const moveNode = useMoveNode(fromParentId);

  /** 弹窗内当前浏览的目录路径栈（根目录 = []）。 */
  const [pathStack, setPathStack] = useState<BreadcrumbEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 每次打开时重置状态
  useEffect(() => {
    if (open) {
      setPathStack([]);
      setError(null);
    }
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open || moveNode.isPending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, moveNode.isPending, onClose]);

  if (!open || typeof document === "undefined") return null;

  const currentParentId = pathStack.at(-1)?.id ?? null;

  function handleEnter(folder: DriveNode) {
    setPathStack((prev) => [...prev, { id: folder.id, name: folder.name }]);
  }

  function handleJump(index: number) {
    setPathStack((prev) => (index < 0 ? [] : prev.slice(0, index + 1)));
  }

  async function handleMove() {
    setError(null);
    try {
      await moveNode.mutateAsync({ id: node.id, parentId: currentParentId });
      onClose();
    } catch {
      setError(t("moveError"));
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("moveTitle")}
        className="flex w-full max-w-[440px] flex-col gap-0 rounded-xl border border-border bg-background shadow-xl overflow-hidden"
      >
        {/* 标题栏 */}
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-[15px] font-semibold text-foreground">
            {t("moveTitle")}
          </h2>
          <p className="text-[12px] text-muted-foreground mt-0.5 truncate">
            {node.name}
          </p>
        </div>

        {/* 面包屑 */}
        <div className="flex items-center gap-1 border-b border-border px-4 py-2 text-xs text-muted-foreground flex-wrap">
          <button
            type="button"
            className="hover:text-foreground transition-colors shrink-0"
            onClick={() => handleJump(-1)}
          >
            {t("moveRoot")}
          </button>
          {pathStack.map((entry, i) => (
            <span key={entry.id ?? i} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 shrink-0" />
              <button
                type="button"
                className="hover:text-foreground transition-colors"
                onClick={() => handleJump(i)}
              >
                {entry.name}
              </button>
            </span>
          ))}
        </div>

        {/* 文件夹列表 */}
        <div className="min-h-[180px] max-h-[300px] overflow-y-auto p-2">
          <FolderBrowser
            browsedParentId={currentParentId}
            excludeId={node.id}
            onEnter={handleEnter}
          />
        </div>

        {/* 错误提示 */}
        {error && (
          <p className="px-4 py-1.5 text-[12px] text-destructive">{error}</p>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={moveNode.isPending}
          >
            {t("moveCancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleMove}
            disabled={moveNode.isPending}
          >
            {moveNode.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {t("moveHere")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
