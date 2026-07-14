"use client";

import { apiClient } from "@meshbot/web-common";
import {
  type ArtifactBodyLabels,
  type ArtifactRemoteTransport,
  type FetchLocalArtifact,
  ArtifactBody as SharedArtifactBody,
} from "@meshbot/web-common/session";
import { useSetAtom } from "jotai";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { artifactRawUrl } from "@/lib/artifact";
import { getFileUrl } from "@/rest/drive";
import {
  fetchRemoteArtifact,
  uploadRemoteArtifactToDrive,
} from "@/rest/remote-devices";

/** PDF 用 react-pdf(client-only，避开 static export 的 SSR/prerender 与 pdf.js worker)。 */
const PdfView = dynamic(() => import("./pdf-view").then((m) => m.PdfView), {
  ssr: false,
});

/**
 * 本机 path 源读取适配：经 apiClient 带 Authorization token，避免 iframe/img
 * 直连 401；`download` 时走 artifactRawUrl 的 download 查询参数（恒二进制）。
 */
export const fetchLocalArtifact: FetchLocalArtifact = (path, opts) =>
  apiClient
    .get<string | Blob>(
      artifactRawUrl(path, opts.download ? { download: true } : undefined),
      { responseType: opts.isText ? "text" : "blob" },
    )
    .then((res) => res.data);

/**
 * 远程产物读取/上传适配：包既有 `fetchRemoteArtifact`/`uploadRemoteArtifactToDrive`
 * REST（经本机 server-agent relay 到设备），匹配共享 `ArtifactRemoteTransport`
 * 形状。不用 `createRemoteSessionTransport`（session-transport.ts）整套——那套
 * 额外带 run 帧 socket 订阅，产物预览只需这两个方法，实例化整套白白多订阅。
 */
export function createArtifactRemoteTransport(
  deviceId: string,
): ArtifactRemoteTransport {
  return {
    readArtifact: (sessionId, path) =>
      fetchRemoteArtifact(deviceId, sessionId, path),
    uploadArtifactToDrive: (sessionId, path) =>
      uploadRemoteArtifactToDrive(deviceId, sessionId, path),
  };
}

/** ArtifactBody 文案：`useTranslations("session.artifact")` 组装共享组件所需 labels。 */
export function useArtifactBodyLabels(): ArtifactBodyLabels {
  const t = useTranslations("session.artifact");
  return {
    loading: t("loading"),
    loadFailed: t("loadFailed"),
    unsupported: t("unsupported"),
    tooLarge: (sizeMb: string) => t("tooLarge", { size: sizeMb }),
    tooLargeHint: t("tooLargeHint"),
    uploadFailed: t("uploadFailed"),
    uploading: t("uploading"),
    uploadToDrive: t("uploadToDrive"),
    previewTitle: t("previewTitle"),
    imageAlt: t("imageAlt"),
  };
}

/** PDF 渲染注入：react-pdf 的 PdfView（web-agent 专属依赖，不进 web-common）。 */
export function renderArtifactPdf(blobUrl: string) {
  return <PdfView url={blobUrl} />;
}

/**
 * 按类型分发渲染产物内容（web-agent 装配壳）：正文/数据源分支已迁
 * `@meshbot/web-common/session`（web-main 会话壳复用 Task 3），此处只做
 * 本机/远程数据源、文案、PDF 渲染的注入组装；消费方 props 与迁移前一致
 * （path/url/name/remote/title），import 路径不变。
 */
export function ArtifactBody({
  path,
  url,
  name,
  remote,
  title,
}: {
  path?: string;
  url?: string;
  name?: string;
  /** 远程设备产物来源（path 为对端工作区相对路径）。 */
  remote?: { deviceId: string; sessionId: string };
  title?: string;
}) {
  const labels = useArtifactBodyLabels();
  const setPreviewArtifact = useSetAtom(previewArtifactAtom);
  const transport = remote
    ? createArtifactRemoteTransport(remote.deviceId)
    : undefined;

  return (
    <SharedArtifactBody
      path={path}
      url={url}
      name={name}
      remote={remote}
      labels={labels}
      fetchLocal={fetchLocalArtifact}
      transport={transport}
      renderPdf={renderArtifactPdf}
      onUploadedToDrive={async (up) => {
        // 远程大产物上传网盘成功后：取 presigned URL，切换预览来源为网盘 url
        // （atom 替换，组件自动重渲染）。
        const presigned = await getFileUrl(up.fileId);
        setPreviewArtifact({ url: presigned.url, name: up.name, title });
      }}
    />
  );
}
