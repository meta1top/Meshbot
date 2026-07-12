"use client";
import { useAtomValue, useSetAtom } from "jotai";
import { Download, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import {
  ArtifactBody,
  downloadArtifact,
} from "@/components/artifact/artifact-body";

/** 产物中区分栏正文：工具栏(标题/下载/关闭) + ArtifactBody。关闭清 previewArtifactAtom。 */
export function ArtifactSplitPane() {
  const t = useTranslations("rightZone");
  const artifact = useAtomValue(previewArtifactAtom);
  const setPreviewArtifact = useSetAtom(previewArtifactAtom);
  if (!artifact) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        {t("artifactEmpty")}
      </div>
    );
  }
  const title =
    artifact.title ??
    artifact.name ??
    artifact.path?.split("/").pop() ??
    t("artifactUntitled");
  return (
    <div className="flex h-full flex-col bg-(--shell-content)">
      {/* 标题栏拖拽区结构性拆分：drag 只包标题文字区，按钮组在 drag 容器外。
          面板 aside 常驻 DOM 靠 transform 滑入——transform 不触发布局变化，
          Electron 不重算 draggable regions，收起态被裁剪时按钮的 no-drag 洞
          可能未登记（首次点击被吞，点正文触发重算才恢复）。按钮不进 drag
          矩形就不依赖洞的登记时序。 */}
      <div className="flex h-13 shrink-0 items-center border-b border-border">
        <div className="drag-handle flex h-full min-w-0 flex-1 items-center px-3">
          <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2 pr-3">
          <button
            type="button"
            title={t("artifactDownload")}
            onClick={() =>
              void downloadArtifact({
                path: artifact.path,
                url: artifact.url,
                name: title,
              })
            }
            className="app-no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t("artifactClose")}
            onClick={() => setPreviewArtifact(null)}
            className="app-no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ArtifactBody
          path={artifact.path}
          url={artifact.url}
          name={artifact.name}
          remote={artifact.remote}
          title={artifact.title}
        />
      </div>
    </div>
  );
}
