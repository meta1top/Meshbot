"use client";

import { apiClient } from "@meshbot/web-common";
import { artifactKind } from "@meshbot/web-common/session";
import { useSetAtom } from "jotai";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { MarkdownContent } from "@/components/session/markdown-content";
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
 * 拉取产物内容，支持两种来源：
 * - path 源（产物）：经 apiClient 带 Authorization token，避免 iframe/img 直连 401
 * - url 源（网盘 presigned）：裸 fetch，presigned URL 自带凭证，不需要 apiClient token
 * 二进制（html/pdf/image）→ blob ObjectURL；文本（markdown/text）→ string。
 */
/** base64 → Uint8Array（独立 ArrayBuffer，满足 BlobPart/TextDecoder 两用）。 */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function useArtifactContent(
  path: string | undefined,
  url: string | undefined,
  name: string | undefined,
  remote: { deviceId: string; sessionId: string } | undefined,
): {
  blobUrl: string | null;
  text: string | null;
  err: boolean;
  tooLarge: { size: number; name: string } | null;
} {
  // 类型判定：path 源用 path，url 源用 name，都没有则 binary
  const kindTarget = path ?? name ?? "";
  const kind = artifactKind(kindTarget);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [tooLarge, setTooLarge] = useState<{
    size: number;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (kind === "binary") return;
    // 两种来源都没有时不拉取
    if (!path && !url) return;
    let cancelled = false;
    let obj: string | null = null;
    setBlobUrl(null);
    setText(null);
    setErr(false);
    setTooLarge(null);
    // html 也按文本拉取，用 iframe srcDoc 渲染——不依赖 blob 的 MIME（presigned 可能不带 Content-Type）
    const isText = kind === "markdown" || kind === "text" || kind === "html";

    // 远程产物：经设备查询通道拉内联内容；too-large 由专属状态承接（非错误）。
    if (remote && path) {
      fetchRemoteArtifact(remote.deviceId, remote.sessionId, path)
        .then((r) => {
          if (cancelled) return;
          if (r.kind === "too-large") {
            setTooLarge({ size: r.size, name: r.name });
            return;
          }
          const bytes = base64ToBytes(r.base64);
          if (isText) {
            setText(new TextDecoder().decode(bytes));
          } else {
            obj = URL.createObjectURL(new Blob([bytes]));
            setBlobUrl(obj);
          }
        })
        .catch(() => {
          if (!cancelled) setErr(true);
        });
      return () => {
        cancelled = true;
        if (obj) URL.revokeObjectURL(obj);
      };
    }

    const fetchContent: Promise<string | Blob> = url
      ? // 网盘 presigned：裸 fetch，presigned URL 自带凭证
        fetch(url).then((r): Promise<string | Blob> => {
          if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
          return isText ? r.text() : r.blob();
        })
      : // 产物源：apiClient 带 Authorization token（path 在此分支必然有值）
        apiClient
          .get<string | Blob>(artifactRawUrl(path ?? ""), {
            responseType: isText ? "text" : "blob",
          })
          .then((res: { data: string | Blob }) => res.data);

    fetchContent
      .then((data: string | Blob) => {
        if (cancelled) return;
        if (isText) {
          setText(typeof data === "string" ? data : String(data));
        } else {
          // cancelled 检查在 createObjectURL 前，防止泄漏
          obj = URL.createObjectURL(data as Blob);
          setBlobUrl(obj);
        }
      })
      .catch(() => {
        if (!cancelled) setErr(true);
      });
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
    // name 不直接用于 effect 内部（只影响 kind，kind 已在依赖中）
  }, [path, url, kind, remote]);

  return { blobUrl, text, err, tooLarge };
}

/**
 * 下载产物，支持两种来源：
 * - url 源（网盘 presigned）：直接设 a.href=url + a.download=name（presigned 自带凭证）
 * - path 源（产物）：apiClient 取 blob（带 token）→ a.download
 */
export async function downloadArtifact(opts: {
  path?: string;
  url?: string;
  name?: string;
}): Promise<void> {
  const { path, url, name } = opts;
  const filename = name ?? path?.split("/").pop() ?? "file";

  if (url) {
    // presigned 直链下载，无需 apiClient
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    return;
  }

  if (path) {
    const res = await apiClient.get(artifactRawUrl(path, { download: true }), {
      responseType: "blob",
    });
    const blobUrl = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(blobUrl);
  }
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      加载中…
    </div>
  );
}

/**
 * 按类型分发渲染产物内容（preview 面板与全屏共用）。
 * 支持两种来源：
 * - path 源：server-agent 产物，经 apiClient 带 token 拉取
 * - url + name 源：网盘 presigned，裸 fetch 自带凭证
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
  const kindTarget = path ?? name ?? "";
  const kind = artifactKind(kindTarget);
  const { blobUrl, text, err, tooLarge } = useArtifactContent(
    path,
    url,
    name,
    remote,
  );
  const setPreviewArtifact = useSetAtom(previewArtifactAtom);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState(false);

  // 远程大产物：提示上传网盘预览；确认后 B 设备上传 → 本机取 presigned URL
  // → 切换预览来源为网盘 url（atom 替换，组件自动重渲染）。
  if (tooLarge && remote && path) {
    const sizeMb = (tooLarge.size / 1024 / 1024).toFixed(1);
    const onUpload = async () => {
      setUploading(true);
      setUploadErr(false);
      try {
        const up = await uploadRemoteArtifactToDrive(
          remote.deviceId,
          remote.sessionId,
          path,
        );
        const presigned = await getFileUrl(up.fileId);
        setPreviewArtifact({ url: presigned.url, name: up.name, title });
      } catch {
        setUploadErr(true);
        setUploading(false);
      }
    };
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium text-foreground">
          文件较大（{sizeMb} MB），无法直接远程预览
        </p>
        <p className="text-xs text-muted-foreground">
          可上传到企业网盘后在本机预览
        </p>
        {uploadErr && (
          <p className="text-xs text-destructive">上传失败，请重试</p>
        )}
        <button
          type="button"
          disabled={uploading}
          onClick={() => void onUpload()}
          className="rounded-md bg-(--shell-accent) px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-60"
        >
          {uploading ? "上传中…" : "上传到网盘并预览"}
        </button>
      </div>
    );
  }

  if (err) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        产物已不存在或已变更
      </div>
    );
  }
  if (kind === "pdf") {
    if (!blobUrl) return <Loading />;
    return (
      <div className="h-full overflow-auto">
        <PdfView url={blobUrl} />
      </div>
    );
  }
  if (kind === "html") {
    if (text === null) return <Loading />;
    return (
      <iframe
        title="产物预览"
        srcDoc={text}
        sandbox=""
        className="h-full w-full border-0 bg-white"
      />
    );
  }
  if (kind === "image") {
    if (!blobUrl) return <Loading />;
    return (
      <div className="flex h-full items-center justify-center p-3">
        {/* biome-ignore lint/performance/noImgElement: 产物是 blob ObjectURL，next/image 不支持 */}
        <img
          src={blobUrl}
          alt="产物"
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }
  if (kind === "markdown") {
    return (
      <div className="px-4 py-3 text-sm">
        {text === null ? <Loading /> : <MarkdownContent text={text} />}
      </div>
    );
  }
  if (kind === "text") {
    return (
      <pre className="overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
        {text ?? "加载中…"}
      </pre>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
      该类型不支持预览，请下载查看。
    </div>
  );
}
