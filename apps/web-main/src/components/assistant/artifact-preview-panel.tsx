"use client";

import { Button } from "@meshbot/design";
import type { ArtifactPreviewTarget } from "@meshbot/web-common/session";
import { artifactKind, MarkdownContent } from "@meshbot/web-common/session";
import { Download, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { createRemoteSessionTransport } from "@/lib/session-transport";

/** base64 → Uint8Array（独立 ArrayBuffer，满足 BlobPart/TextDecoder 两用）。 */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface ArtifactPreviewPanelProps {
  /** 非空即打开；`target.remote` 缺失时（理论上不会发生——web-main 只有远程会话）视为无效，不渲染。 */
  target:
    | (ArtifactPreviewTarget & {
        remote: { deviceId: string; sessionId: string };
      })
    | null;
  onClose: () => void;
}

/**
 * 产物预览浮层（web-main 简版，overlay + 居中面板，非 web-agent 那种常驻可拖拽
 * 分栏 `ArtifactSplitPane`——web-main 首次接入产物预览，无既有分栏基础设施，
 * 用 `ConfirmDialog` 同款 `createPortal` + `fixed inset-0` 模式足够，报告已记录
 * 该取舍）。
 *
 * 数据源移植自 `apps/web-agent/src/components/artifact/artifact-body.tsx` 的
 * remote 分支：REST 直连 `fetchRemoteArtifact`/`uploadRemoteArtifactToDrive`
 * 换成 `SessionTransport.readArtifact`/`uploadArtifactToDrive`（T10 已把这两个
 * 方法接到 `device.query` 通道，`kind: "artifact-file"/"artifact-upload-drive"`）。
 *
 * 简化（详见任务报告）：
 * - 不支持 PDF 专属渲染（react-pdf，web-main 未引入该依赖）——退化为浏览器
 *   原生 `<iframe>` PDF 查看器（现代浏览器均内置，无需额外依赖）。
 * - 太大文件上传网盘后不做「自动切换预览源」（web-agent 有，依赖网盘
 *   presigned URL REST，web-main 暂无网盘前端基础设施）——只报告上传成功 +
 *   文件名，用户自行去网盘查看（网盘页面本身当前仍是占位 stub）。
 */
export function ArtifactPreviewPanel({
  target,
  onClose,
}: ArtifactPreviewPanelProps) {
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target || typeof document === "undefined") return null;

  return createPortal(
    <ArtifactPreviewContent target={target} onClose={onClose} />,
    document.body,
  );
}

function ArtifactPreviewContent({
  target,
  onClose,
}: {
  target: ArtifactPreviewTarget & {
    remote: { deviceId: string; sessionId: string };
  };
  onClose: () => void;
}) {
  const t = useTranslations("session.artifact");
  const { deviceId, sessionId } = target.remote;
  const kind = artifactKind(target.path);
  const transport = useMemo(
    () => createRemoteSessionTransport(deviceId),
    [deviceId],
  );
  // deviceId 切换（同一面板会话内预览另一台设备的产物，罕见但可能）会让
  // useMemo 换出一个新 transport 实例；组件卸载（面板关闭）同理——两种情况
  // 都要释放旧 transport 常驻的三个 socket 监听器，否则在 module 级单例
  // socket 上无界累积。
  useEffect(() => {
    return () => {
      transport.dispose?.();
    };
  }, [transport]);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "tooLarge"; size: number; name: string }
    | { status: "ready"; text: string | null; blobUrl: string | null }
  >({ status: "loading" });
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<
    "idle" | "success" | "error"
  >("idle");

  useEffect(() => {
    let cancelled = false;
    let obj: string | null = null;
    setState({ status: "loading" });
    setUploadResult("idle");
    const isText = kind === "markdown" || kind === "text" || kind === "html";
    transport
      .readArtifact(sessionId, target.path)
      .then((r) => {
        if (cancelled) return;
        if (r.kind === "too-large") {
          setState({ status: "tooLarge", size: r.size, name: r.name });
          return;
        }
        const bytes = base64ToBytes(r.base64);
        if (isText) {
          setState({
            status: "ready",
            text: new TextDecoder().decode(bytes),
            blobUrl: null,
          });
        } else {
          obj = URL.createObjectURL(new Blob([bytes]));
          setState({ status: "ready", text: null, blobUrl: obj });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [transport, sessionId, target.path, kind]);

  const handleUpload = async () => {
    setUploading(true);
    setUploadResult("idle");
    try {
      await transport.uploadArtifactToDrive(sessionId, target.path);
      setUploadResult("success");
    } catch {
      setUploadResult("error");
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = () => {
    if (state.status !== "ready") return;
    const name = target.title ?? target.path.split("/").pop() ?? "file";
    if (state.blobUrl) {
      const a = document.createElement("a");
      a.href = state.blobUrl;
      a.download = name;
      a.click();
      return;
    }
    if (state.text !== null) {
      const blob = new Blob([state.text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {target.title ?? target.path.split("/").pop() ?? target.path}
          </span>
          {state.status === "ready" && (
            <button
              type="button"
              onClick={handleDownload}
              title={t("download")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Download className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title={t("close")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <ArtifactPreviewBody state={state} kind={kind} />
        </div>
        {state.status === "tooLarge" && (
          <div className="flex shrink-0 flex-col items-center gap-2 border-t border-border px-4 py-3">
            {uploadResult === "success" ? (
              <p className="text-xs text-muted-foreground">
                {t("uploadSuccess", { name: state.name })}
              </p>
            ) : (
              <>
                {uploadResult === "error" && (
                  <p className="text-xs text-destructive">
                    {t("uploadFailed")}
                  </p>
                )}
                <Button
                  size="sm"
                  disabled={uploading}
                  onClick={() => void handleUpload()}
                >
                  {uploading ? t("uploading") : t("uploadToDrive")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactPreviewBody({
  state,
  kind,
}: {
  state:
    | { status: "loading" }
    | { status: "error" }
    | { status: "tooLarge"; size: number; name: string }
    | { status: "ready"; text: string | null; blobUrl: string | null };
  kind: ReturnType<typeof artifactKind>;
}) {
  const t = useTranslations("session.artifact");
  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("loading")}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        {t("loadFailed")}
      </div>
    );
  }
  if (state.status === "tooLarge") {
    const sizeMb = (state.size / 1024 / 1024).toFixed(1);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium text-foreground">
          {t("tooLarge", { size: sizeMb })}
        </p>
      </div>
    );
  }
  if (kind === "pdf") {
    if (!state.blobUrl) return null;
    return (
      <iframe
        title="产物预览"
        src={state.blobUrl}
        className="h-full w-full border-0"
      />
    );
  }
  if (kind === "html") {
    if (state.text === null) return null;
    return (
      <iframe
        title="产物预览"
        srcDoc={state.text}
        sandbox=""
        className="h-full w-full border-0 bg-white"
      />
    );
  }
  if (kind === "image") {
    if (!state.blobUrl) return null;
    return (
      <div className="flex h-full items-center justify-center p-3">
        {/* biome-ignore lint/performance/noImgElement: 产物是 blob ObjectURL，next/image 不支持 */}
        <img
          src={state.blobUrl}
          alt="产物"
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }
  if (kind === "markdown") {
    return (
      <div className="px-4 py-3 text-sm">
        {state.text !== null && <MarkdownContent text={state.text} />}
      </div>
    );
  }
  if (kind === "text") {
    return (
      <pre className="overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
        {state.text ?? ""}
      </pre>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
      {t("unsupported")}
    </div>
  );
}
