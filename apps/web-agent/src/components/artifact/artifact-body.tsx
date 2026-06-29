"use client";

import { apiClient } from "@meshbot/web-common";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { MarkdownContent } from "@/components/session/markdown-content";
import { artifactKind, artifactRawUrl } from "@/lib/artifact";

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
function useArtifactContent(
  path: string | undefined,
  url: string | undefined,
  name: string | undefined,
): {
  blobUrl: string | null;
  text: string | null;
  err: boolean;
} {
  // 类型判定：path 源用 path，url 源用 name，都没有则 binary
  const kindTarget = path ?? name ?? "";
  const kind = artifactKind(kindTarget);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (kind === "binary") return;
    // 两种来源都没有时不拉取
    if (!path && !url) return;
    let cancelled = false;
    let obj: string | null = null;
    setBlobUrl(null);
    setText(null);
    setErr(false);
    const isText = kind === "markdown" || kind === "text";

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
  }, [path, url, kind]);

  return { blobUrl, text, err };
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
}: {
  path?: string;
  url?: string;
  name?: string;
}) {
  const kindTarget = path ?? name ?? "";
  const kind = artifactKind(kindTarget);
  const { blobUrl, text, err } = useArtifactContent(path, url, name);

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
    if (!blobUrl) return <Loading />;
    return (
      <iframe
        title="产物预览"
        src={blobUrl}
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
