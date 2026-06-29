"use client";

import { Button } from "@meshbot/design";
import { FolderPlus, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import {
  type BreadcrumbEntry,
  DriveBreadcrumb,
} from "@/components/drive/drive-breadcrumb";
import { DriveFileList } from "@/components/drive/drive-file-list";
import { ToolPage } from "@/components/layouts/tool-page";
import { type DriveNode, useDriveNodes, useDriveShared } from "@/rest/drive";

/** 当前 tab：「我的文件」或「共享给我的」。 */
type DriveTab = "mine" | "shared";

/** 「我的文件」tab 内容区。 */
function MineContent({
  pathStack,
  onJump,
  onEnterFolder,
}: {
  pathStack: BreadcrumbEntry[];
  onJump: (index: number) => void;
  onEnterFolder: (node: DriveNode) => void;
}) {
  const parentId = pathStack.at(-1)?.id ?? null;
  const { data: nodes = [], isLoading } = useDriveNodes(parentId);

  /** 文件预览占位（Task 6 接入）。 */
  function handlePreview(_node: DriveNode) {
    // TODO Task 6: 接入产物预览面板
  }

  return (
    <div className="flex flex-col gap-3">
      <DriveBreadcrumb pathStack={pathStack} onJump={onJump} />
      <DriveFileList
        nodes={nodes}
        loading={isLoading}
        onEnterFolder={onEnterFolder}
        onPreview={handlePreview}
      />
    </div>
  );
}

/** 「共享给我的」tab 内容区（只读，不进夹）。 */
function SharedContent() {
  const { data: nodes = [], isLoading } = useDriveShared();

  function handleEnterFolder(_node: DriveNode) {
    // 共享 tab 暂不进入子目录
  }

  function handlePreview(_node: DriveNode) {
    // TODO Task 6: 接入产物预览面板
  }

  return (
    <DriveFileList
      nodes={nodes}
      loading={isLoading}
      onEnterFolder={handleEnterFolder}
      onPreview={handlePreview}
    />
  );
}

/**
 * 网盘主页面：tab 切换（我的文件 / 共享给我的）+ 面包屑导航 + 文件列表。
 */
export default function DrivePage() {
  const t = useTranslations("drive");

  /** 当前激活 tab。 */
  const [tab, setTab] = useState<DriveTab>("mine");

  /** 目录路径栈（根为 []）。 */
  const [pathStack, setPathStack] = useState<BreadcrumbEntry[]>([]);

  /** 进入文件夹，将节点压栈。 */
  const handleEnterFolder = useCallback((node: DriveNode) => {
    if (node.type !== "folder") return;
    setPathStack((prev) => [...prev, { id: node.id, name: node.name }]);
  }, []);

  /** 面包屑跳转：index = -1 回根，否则截断到 index+1。 */
  const handleJump = useCallback((index: number) => {
    setPathStack((prev) => (index < 0 ? [] : prev.slice(0, index + 1)));
  }, []);

  /** 切换 tab 时重置路径栈。 */
  function handleTabChange(nextTab: DriveTab) {
    setTab(nextTab);
    setPathStack([]);
  }

  const isMine = tab === "mine";

  return (
    <ToolPage
      title={t("title")}
      tabs={
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => handleTabChange("mine")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              isMine
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("tabMine")}
          </button>
          <button
            type="button"
            onClick={() => handleTabChange("shared")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              !isMine
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("tabShared")}
          </button>
        </div>
      }
      actions={
        isMine ? (
          <div className="flex items-center gap-2">
            {/* Task 3 接入：上传文件 */}
            <Button variant="ghost" size="sm" className="gap-1.5" disabled>
              <Upload className="h-4 w-4" />
              {t("upload")}
            </Button>
            {/* Task 4 接入：新建文件夹 */}
            <Button variant="ghost" size="sm" className="gap-1.5" disabled>
              <FolderPlus className="h-4 w-4" />
              {t("newFolder")}
            </Button>
          </div>
        ) : undefined
      }
    >
      {isMine ? (
        <MineContent
          pathStack={pathStack}
          onJump={handleJump}
          onEnterFolder={handleEnterFolder}
        />
      ) : (
        <SharedContent />
      )}
    </ToolPage>
  );
}
