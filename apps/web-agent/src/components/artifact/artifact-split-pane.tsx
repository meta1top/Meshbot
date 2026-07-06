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
      <div className="flex h-13 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          {title}
        </span>
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
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={t("artifactClose")}
          onClick={() => setPreviewArtifact(null)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ArtifactBody
          path={artifact.path}
          url={artifact.url}
          name={artifact.name}
        />
      </div>
    </div>
  );
}
