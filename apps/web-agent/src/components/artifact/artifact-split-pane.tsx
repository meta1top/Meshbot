"use client";
import { ArtifactSplitPane as SharedArtifactSplitPane } from "@meshbot/web-common/session";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { getFileUrl } from "@/rest/drive";
import {
  createArtifactRemoteTransport,
  createFetchLocalArtifact,
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
  // 按 deviceId 记忆化，避免每渲染传新函数引用触发 shared 组件的重复拉取
  // （同下方 fetchLocal 的 useMemo 注释；transport 同样进了
  // web-common/artifact-body.tsx 的 effect 依赖数组）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意只依赖 artifact?.remote?.deviceId，createArtifactRemoteTransport 只用这一个字段
  const transport = useMemo(
    () =>
      artifact?.remote
        ? createArtifactRemoteTransport(artifact.remote.deviceId)
        : undefined,
    [artifact?.remote?.deviceId],
  );
  // 按 agentId 记忆化，避免每渲染传新函数引用触发 shared 组件的重复拉取
  // （同 artifact-body.tsx 的 fetchLocal useMemo 注释）。
  const fetchLocal = useMemo(
    () => createFetchLocalArtifact(artifact?.agentId),
    [artifact?.agentId],
  );

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
      fetchLocal={fetchLocal}
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
