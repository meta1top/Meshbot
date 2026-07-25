"use client";
import {
  getArtifactSplitPaneTitle,
  ArtifactSplitPane as SharedArtifactSplitPane,
  ArtifactSplitPaneActions as SharedArtifactSplitPaneActions,
} from "@meshbot/web-common/session";
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
 * 产物预览数据源：按 deviceId/agentId 记忆化 transport/fetchLocal，避免每渲染
 * 传新函数引用触发 shared 组件（正文 + 动作两处都会用到）的重复拉取（同下方
 * `useMemo` 注释；transport 同样进了 web-common/artifact-body.tsx 的 effect
 * 依赖数组）。正文/标题/动作三个槽各自独立订阅 `previewArtifactAtom`，供
 * layout.tsx 分别装进 UnifiedSheet 的 children/title/headerActions。
 */
function usePreviewArtifactSources() {
  const artifact = useAtomValue(previewArtifactAtom);
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
  return { artifact, transport, fetchLocal };
}

/**
 * 产物中区分栏正文（web-agent 装配壳）：正文 chrome 已迁
 * `@meshbot/web-common/session`（web-main 会话壳复用 Task 3），标题栏进一步
 * 拆到 {@link useArtifactSplitPaneTitle}/{@link ArtifactSplitPaneActions}
 * （Task 4，供 layout.tsx 装进 UnifiedSheet 的 title/headerActions 槽）；此处
 * 只做 `previewArtifactAtom` 桥接，做 UnifiedSheet 的 children。关闭清
 * `previewArtifactAtom`。
 */
export function ArtifactSplitPane() {
  const t = useTranslations("rightZone");
  const bodyLabels = useArtifactBodyLabels();
  const { artifact, transport, fetchLocal } = usePreviewArtifactSources();
  const setPreviewArtifact = useSetAtom(previewArtifactAtom);

  return (
    <SharedArtifactSplitPane
      target={artifact}
      labels={{
        empty: t("artifactEmpty"),
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
    />
  );
}

/** 产物预览标题（UnifiedSheet `title` 槽用）：纯字符串，走底座默认排版。 */
export function useArtifactSplitPaneTitle(): string {
  const t = useTranslations("rightZone");
  const artifact = useAtomValue(previewArtifactAtom);
  return getArtifactSplitPaneTitle(artifact, t("artifactUntitled"));
}

/** 产物预览动作（下载/关闭，UnifiedSheet `headerActions` 槽用）。 */
export function ArtifactSplitPaneActions() {
  const t = useTranslations("rightZone");
  const { artifact, transport, fetchLocal } = usePreviewArtifactSources();
  const setPreviewArtifact = useSetAtom(previewArtifactAtom);

  return (
    <SharedArtifactSplitPaneActions
      target={artifact}
      onClose={() => setPreviewArtifact(null)}
      labels={{
        download: t("artifactDownload"),
        close: t("artifactClose"),
        untitled: t("artifactUntitled"),
      }}
      fetchLocal={fetchLocal}
      transport={transport}
    />
  );
}
