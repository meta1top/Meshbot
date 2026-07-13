"use client";

import {
  ArtifactFileCard as ArtifactFileCardBase,
  type ArtifactPreviewTarget,
} from "@meshbot/web-common/session";
import { useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { useRemoteSession } from "@/hooks/remote-session-context";
import type { ToolCallView } from "./message-list";

/**
 * web-agent 薄容器：把 web-common `ArtifactFileCard` 接线到本应用的
 * `previewArtifactAtom`（右侧 dock 预览）与 `useRemoteSession()`（跨设备预览
 * 的对端 deviceId/sessionId）。逻辑/展示已整体迁入 web-common（Task 8），
 * 这里只做「数据源接线」，行为与迁移前逐位一致。
 */
export function ArtifactFileCard({ tool }: { tool: ToolCallView }) {
  const t = useTranslations("session.artifact");
  const setArtifact = useSetAtom(previewArtifactAtom);
  // 远程会话（RemoteSessionProvider 内）：产物在对端设备，预览走设备查询通道。
  const remote = useRemoteSession();

  return (
    <ArtifactFileCardBase
      tool={tool}
      labels={{ presentFailed: t("presentFailed") }}
      remote={
        remote
          ? { deviceId: remote.remoteDeviceId, sessionId: remote.sessionId }
          : null
      }
      onPreview={(target: ArtifactPreviewTarget) => setArtifact(target)}
    />
  );
}
