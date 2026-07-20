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
import { useMemo } from "react";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { artifactRawUrl } from "@/lib/artifact";
import { getFileUrl } from "@/rest/drive";
import {
  fetchRemoteArtifact,
  uploadRemoteArtifactToDrive,
} from "@/rest/remote-agent-sessions";

/** PDF 用 react-pdf(client-only，避开 static export 的 SSR/prerender 与 pdf.js worker)。 */
const PdfView = dynamic(() => import("./pdf-view").then((m) => m.PdfView), {
  ssr: false,
});

/**
 * 本机 path 源读取适配：经 apiClient 带 Authorization token，避免 iframe/img
 * 直连 401；`download` 时走 artifactRawUrl 的 download 查询参数（恒二进制）。
 *
 * `agentId`（Task 12）：产物按 `agents/<agentId>/` workspace 隔离，调用方须
 * 传该产物所属会话的 agentId（见 `artifactRawUrl` 注释），否则多 Agent 下
 * 非默认 Agent 的产物会 404。用 `createFetchLocalArtifact(agentId)` 按需
 * 构造；`fetchLocalArtifact` 保留为无 agentId 的兜底（走后端默认 Agent）。
 */
export function createFetchLocalArtifact(agentId?: string): FetchLocalArtifact {
  return (path, opts) =>
    apiClient
      .get<string | Blob>(
        artifactRawUrl(path, { download: opts.download, agentId }),
        { responseType: opts.isText ? "text" : "blob" },
      )
      .then((res) => res.data);
}

/** 无 agentId 的兜底实现（走后端默认 Agent 解析）。 */
export const fetchLocalArtifact: FetchLocalArtifact =
  createFetchLocalArtifact();

/**
 * 远程产物读取/上传适配：包既有 `fetchRemoteArtifact`/`uploadRemoteArtifactToDrive`
 * REST（经本机 server-agent relay 到远程 Agent 的宿主设备），匹配共享
 * `ArtifactRemoteTransport` 形状。不用 `createRemoteSessionTransport`
 * （session-transport.ts）整套——那套额外带 run 帧 socket 订阅，产物预览只需
 * 这两个方法，实例化整套白白多订阅。
 */
export function createArtifactRemoteTransport(
  agentId: string,
): ArtifactRemoteTransport {
  return {
    readArtifact: (sessionId, path) =>
      fetchRemoteArtifact(agentId, sessionId, path),
    uploadArtifactToDrive: (sessionId, path) =>
      uploadRemoteArtifactToDrive(agentId, sessionId, path),
  };
}

/** ArtifactBody 文案：`useTranslations("session.artifact")` 组装共享组件所需 labels。 */
export function useArtifactBodyLabels(): ArtifactBodyLabels {
  const t = useTranslations("session.artifact");
  return {
    loading: t("loading"),
    loadFailed: t("loadFailed"),
    // 真机验收缺陷 3：四态文案分级（web-agent 提供这三个细分文案；notFound
    // 态复用 loadFailed，见 web-common ArtifactBodyLabels 的字段注释）。
    loadFailedNoSource: t("loadFailedNoSource"),
    loadFailedRemoteRejected: t("loadFailedRemoteRejected"),
    loadFailedRemoteUnreachable: t("loadFailedRemoteUnreachable"),
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
  agentId,
}: {
  path?: string;
  url?: string;
  name?: string;
  /** 远程设备产物来源（path 为对端工作区相对路径）。 */
  remote?: { deviceId: string; sessionId: string };
  title?: string;
  /** 本机产物所属会话的 agentId（Task 12，`remote` 未传时生效）。 */
  agentId?: string;
}) {
  const labels = useArtifactBodyLabels();
  const setPreviewArtifact = useSetAtom(previewArtifactAtom);
  // 按 deviceId 记忆化，理由同下方 fetchLocal 的 useMemo 注释：`transport`
  // 同样进了 `useArtifactContent`（web-common）的 effect 依赖数组，父组件
  // 重渲染若每次传新对象引用会触发重复拉取。有意只依赖 deviceId（而非整个
  // remote 对象）——remote 是调用方每渲染新建的字面量，按对象引用做依赖会
  // 让这个 useMemo 形同虚设；createArtifactRemoteTransport 本就只用 deviceId。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意只依赖 remote?.deviceId，理由见上
  const transport = useMemo(
    () => (remote ? createArtifactRemoteTransport(remote.deviceId) : undefined),
    [remote?.deviceId],
  );
  // 按 agentId 记忆化：`useArtifactContent`（web-common）把 fetchLocal 放进
  // effect 依赖数组，每渲染都传新函数引用会导致产物重复拉取/闪烁。
  const fetchLocal = useMemo(
    () => createFetchLocalArtifact(agentId),
    [agentId],
  );

  return (
    <SharedArtifactBody
      path={path}
      url={url}
      name={name}
      remote={remote}
      labels={labels}
      fetchLocal={fetchLocal}
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
