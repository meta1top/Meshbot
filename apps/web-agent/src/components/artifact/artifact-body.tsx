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
 * 经 apiClient（带 Authorization token）拉产物内容。serving 端点走全局 JWT header
 * 鉴权，iframe/img 直连不带 token 会 401，故所有类型都经 apiClient：
 * 二进制（html/pdf/image）→ blob ObjectURL；文本（markdown/text）→ string。
 */
function useArtifactContent(path: string): {
  blobUrl: string | null;
  text: string | null;
  err: boolean;
} {
  const kind = artifactKind(path);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (kind === "binary") return;
    let cancelled = false;
    let obj: string | null = null;
    setBlobUrl(null);
    setText(null);
    setErr(false);
    const isText = kind === "markdown" || kind === "text";
    apiClient
      .get<string | Blob>(artifactRawUrl(path), {
        responseType: isText ? "text" : "blob",
      })
      .then((res: { data: string | Blob }) => {
        if (cancelled) return;
        if (isText) {
          setText(typeof res.data === "string" ? res.data : String(res.data));
        } else {
          obj = URL.createObjectURL(res.data as Blob);
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
  }, [path, kind]);

  return { blobUrl, text, err };
}

/** 下载产物：apiClient 取 blob（带 token）→ a.download 触发 → 释放 ObjectURL。 */
export async function downloadArtifact(
  path: string,
  name: string,
): Promise<void> {
  const res = await apiClient.get(artifactRawUrl(path, { download: true }), {
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      加载中…
    </div>
  );
}

/** 按类型分发渲染产物内容（preview 面板与全屏共用）。 */
export function ArtifactBody({ path }: { path: string }) {
  const kind = artifactKind(path);
  const { blobUrl, text, err } = useArtifactContent(path);

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
