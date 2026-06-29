"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Download, Maximize2, Share2, X } from "lucide-react";
import { useState } from "react";
import {
  assistantPanelTypeAtom,
  previewArtifactAtom,
} from "@/atoms/assistant-panel";
import { DockTabs } from "@/components/im/dock-tabs";
import { artifactIcon } from "@/lib/artifact-icon";
import { ArtifactBody, downloadArtifact } from "./artifact-body";
import { ArtifactFullscreen } from "./artifact-fullscreen";

/** 产物预览面板（dock 区域，与助手切换）。 */
export function ArtifactPreviewPanel() {
  const artifact = useAtomValue(previewArtifactAtom);
  const setType = useSetAtom(assistantPanelTypeAtom);
  const setArtifact = useSetAtom(previewArtifactAtom);
  const [full, setFull] = useState(false);

  if (!artifact) {
    return null;
  }
  // 标题：优先 title，其次 name（网盘源），其次 path 末段（产物源）
  const title =
    artifact.title ??
    artifact.name ??
    artifact.path?.split("/").pop() ??
    "预览";
  // 图标：path 源用 path，网盘源用 name，都没有则空串（fallback）
  const PreviewIcon = artifactIcon(artifact.path ?? artifact.name ?? "");

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-[linear-gradient(120deg,#fff3ea,#ffe7ef_45%,#eef2ff)] px-3.5 dark:bg-none">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-(--shell-accent) text-white">
          <PreviewIcon className="h-3.5 w-3.5" />
        </span>
        <DockTabs />
        <button
          type="button"
          onClick={() =>
            void downloadArtifact({
              path: artifact.path,
              url: artifact.url,
              name: title,
            })
          }
          title="下载"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setFull(true)}
          title="全屏"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled
          title="分享（即将上线）"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/40"
        >
          <Share2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setArtifact(null);
            setType("assistant");
          }}
          title="关闭"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 透传两源：path 源或 url+name 源，ArtifactBody 内部分支处理 */}
        <ArtifactBody
          path={artifact.path}
          url={artifact.url}
          name={artifact.name}
        />
      </div>
      {full && (
        <ArtifactFullscreen
          path={artifact.path}
          url={artifact.url}
          name={artifact.name}
          title={title}
          onClose={() => setFull(false)}
        />
      )}
    </div>
  );
}
