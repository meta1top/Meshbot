"use client";
import { ArtifactSplitPane as SharedArtifactSplitPane } from "@meshbot/web-common/session";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { getFileUrl } from "@/rest/drive";
import {
  createArtifactRemoteTransport,
  fetchLocalArtifact,
  renderArtifactPdf,
  useArtifactBodyLabels,
} from "./artifact-body";

/**
 * 产物中区分栏正文（web-agent 装配壳）：工具栏/正文 chrome 已迁
 * `@meshbot/web-common/session`（web-main 会话壳复用 Task 3），此处只做
 * `previewArtifactAtom` 桥接 + Electron 拖拽区类名装配。关闭清
 * `previewArtifactAtom`。
 */
export function ArtifactSplitPane() {
  const t = useTranslations("rightZone");
  const bodyLabels = useArtifactBodyLabels();
  const artifact = useAtomValue(previewArtifactAtom);
  const setPreviewArtifact = useSetAtom(previewArtifactAtom);
  const transport = artifact?.remote
    ? createArtifactRemoteTransport(artifact.remote.deviceId)
    : undefined;

  return (
    <SharedArtifactSplitPane
      target={artifact}
      onClose={() => setPreviewArtifact(null)}
      labels={{
        empty: t("artifactEmpty"),
        untitled: t("artifactUntitled"),
        download: t("artifactDownload"),
        close: t("artifactClose"),
        body: bodyLabels,
      }}
      fetchLocal={fetchLocalArtifact}
      transport={transport}
      renderPdf={renderArtifactPdf}
      onUploadedToDrive={async (up) => {
        const presigned = await getFileUrl(up.fileId);
        setPreviewArtifact({
          url: presigned.url,
          name: up.name,
          title: artifact?.title,
        });
      }}
      titleBarClassName="drag-handle"
      actionButtonClassName="app-no-drag"
    />
  );
}
