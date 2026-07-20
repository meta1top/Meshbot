"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { artifactKind } from "./artifact-kind";
import { MarkdownContent } from "./markdown-content";

/** base64 → Uint8Array（独立 ArrayBuffer，满足 BlobPart/TextDecoder 两用）。 */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * 产物加载失败的展示态（真机验收缺陷 3）：原实现把三类完全不同的失败——
 * transport 缺失（根本没发请求）、远程链路失败（拒绝/不可达）、本机 404——
 * 全塞进一个 `err` 布尔，统一显示「产物已不存在或已变更」。这次就是它把
 * 「打错了机器的 404」伪装成「文件没了」，把排查方向带偏到设备白名单上，
 * 浪费了一整轮真机验收。至少区分这四态，文案才能指向真实原因。
 *
 * - `noSource`：`remote` 产物但未注入 `transport`——配置/接线错误，从未发出
 *   任何网络请求。
 * - `remoteRejected`：远程查询发出且拿到了明确的失败响应（如归属/白名单
 *   校验不通过、对端处理出错）。
 * - `remoteUnreachable`：远程查询发出但没能拿到确定结果（超时 / 网络层
 *   失败，包括对端离线的上报）。
 * - `notFound`：本机产物源 404 或网络错误（`fetchLocal` 失败）。
 */
export type ArtifactLoadErrorKind =
  | "noSource"
  | "remoteRejected"
  | "remoteUnreachable"
  | "notFound";

/**
 * 远程产物加载失败的错误分类：能拿到 HTTP status 就细分，拿不到（网络层
 * 失败，没有响应）一律归「不可达」。
 *
 * 判据取自后端两个错误码的语义（`apps/server-agent/src/errors/agent.error-codes.ts`）：
 * `REMOTE_QUERY_TIMEOUT`（504，等不到对端响应）→ 不可达；
 * `REMOTE_QUERY_UNAVAILABLE`（409，对端已给出明确的失败结果——涵盖白名单/
 * 归属校验拒绝、对端离线上报、对端处理出错，后端目前未再细分这几种）→ 拒绝。
 * 这条边界不完美（409 也覆盖「对端离线」，语义上更接近"不可达"），但已是
 * 浏览器侧能拿到的最细粒度信号——要更精确需要后端把 `reason` 透传到 HTTP
 * 层，超出本次范围。
 */
export function classifyRemoteArtifactError(
  err: unknown,
): "remoteRejected" | "remoteUnreachable" {
  const status = (err as { response?: { status?: number } } | null | undefined)
    ?.response?.status;
  if (status === undefined || status === 504) return "remoteUnreachable";
  return "remoteRejected";
}

/** 按错误态选文案；未提供细分文案（如 web-main 暂未跟进）时回退通用 `loadFailed`。 */
export function resolveLoadFailedText(
  labels: ArtifactBodyLabels,
  err: ArtifactLoadErrorKind,
): string {
  switch (err) {
    case "noSource":
      return labels.loadFailedNoSource ?? labels.loadFailed;
    case "remoteRejected":
      return labels.loadFailedRemoteRejected ?? labels.loadFailed;
    case "remoteUnreachable":
      return labels.loadFailedRemoteUnreachable ?? labels.loadFailed;
    default:
      return labels.loadFailed;
  }
}

/** ArtifactBody 的 i18n 文案注入（web-common 禁 next-intl，调用方经 useTranslations 组装）。 */
export interface ArtifactBodyLabels {
  loading: string;
  /** 通用兜底文案：未提供对应细分文案时使用，也是 `notFound` 态的专属文案
   *  （本机产物 404 本就是这句话原本描述的场景，不再另开一个键）。 */
  loadFailed: string;
  /** `noSource` 态专属文案（remote 产物缺 transport）；不传回退 `loadFailed`。 */
  loadFailedNoSource?: string;
  /** `remoteRejected` 态专属文案（远端明确拒绝/出错）；不传回退 `loadFailed`。 */
  loadFailedRemoteRejected?: string;
  /** `remoteUnreachable` 态专属文案（远端不可达：超时/离线/网络失败）；不传回退 `loadFailed`。 */
  loadFailedRemoteUnreachable?: string;
  unsupported: string;
  /** 远程大产物提示文案；size 为调用方已格式化好的 MB 数字字符串（如 "3.2"）。 */
  tooLarge: (sizeMb: string) => string;
  /** tooLarge 提示副文案（如「可上传到企业网盘后在本机预览」）；不传则不渲染该行。 */
  tooLargeHint?: string;
  uploadFailed: string;
  uploading: string;
  uploadToDrive: string;
  /** pdf/html 预览 iframe 的 title 属性（无障碍 + 悬浮提示）。 */
  previewTitle: string;
  /** 图片预览的 alt 文案。 */
  imageAlt: string;
}

/**
 * 远程产物读取/上传能力：方法签名与 {@link ../transport.ts 的 `SessionTransport`}
 * 同名方法一致，可直接传该 transport 实例的子集（web-main 场景）；web-agent
 * 场景无需整套 SessionTransport（含 run 帧订阅等），传一个包 REST 的轻量适配即可。
 */
export interface ArtifactRemoteTransport {
  readArtifact(
    sessionId: string,
    path: string,
  ): Promise<
    | { kind: "content"; name: string; base64: string }
    | { kind: "too-large"; name: string; size: number }
  >;
  uploadArtifactToDrive(
    sessionId: string,
    path: string,
  ): Promise<{ fileId: string; name: string }>;
}

/**
 * 本机 path 源内容读取适配（`remote` 未传时生效）：web-agent 传 apiClient 适配
 * （经 artifactRawUrl 带 token，避免 iframe/img 直连 401）；web-main 无本机产物
 * 概念，不传。`download` 为 true 时用于触发下载（恒二进制，忽略 isText）。
 */
export type FetchLocalArtifact = (
  path: string,
  opts: { isText: boolean; download?: boolean },
) => Promise<string | Blob>;

export interface ArtifactBodyProps {
  /** server-agent 本机产物相对路径（`remote` 未传时经 `fetchLocal` 拉取）。 */
  path?: string;
  /** 网盘 presigned URL（裸 fetch，自带凭证，不需要 fetchLocal/transport）。 */
  url?: string;
  /** 文件名（url 源用它判类型 + 下载名）。 */
  name?: string;
  /** 远程设备产物来源（path 为对端工作区相对路径），经 `transport` 读取。 */
  remote?: { deviceId: string; sessionId: string };
  title?: string;
  labels: ArtifactBodyLabels;
  fetchLocal?: FetchLocalArtifact;
  transport?: ArtifactRemoteTransport;
  /**
   * PDF 渲染注入（web-agent 传 react-pdf 的 `PdfView`）：web-common/web-main
   * 无 react-pdf 依赖，缺省退化为浏览器原生 `<iframe src=blobUrl>` PDF 查看器。
   */
  renderPdf?: (blobUrl: string) => ReactNode;
  /**
   * 远程大产物「上传到网盘并预览」成功后的回调：调用方决定后续动作（如
   * web-agent 再取 presigned url 写回本地预览状态；web-main 可只提示成功）。
   * 若返回 Promise 且被拒绝，视为上传失败（与 uploadArtifactToDrive 本身
   * 失败同等对待，均置 uploadFailed 态）。
   */
  onUploadedToDrive?: (result: {
    fileId: string;
    name: string;
  }) => void | Promise<void>;
}

function useArtifactContent(
  path: string | undefined,
  url: string | undefined,
  name: string | undefined,
  remote: { deviceId: string; sessionId: string } | undefined,
  fetchLocal: FetchLocalArtifact | undefined,
  transport: ArtifactRemoteTransport | undefined,
): {
  blobUrl: string | null;
  text: string | null;
  err: ArtifactLoadErrorKind | null;
  tooLarge: { size: number; name: string } | null;
} {
  // 类型判定：path 源用 path，url 源用 name，都没有则 binary
  const kindTarget = path ?? name ?? "";
  const kind = artifactKind(kindTarget);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<ArtifactLoadErrorKind | null>(null);
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
    setErr(null);
    setTooLarge(null);
    // html 也按文本拉取，用 iframe srcDoc 渲染——不依赖 blob 的 MIME（presigned 可能不带 Content-Type）
    const isText = kind === "markdown" || kind === "text" || kind === "html";

    // 远程产物：经注入的 transport 拉内联内容；too-large 由专属状态承接（非错误）。
    if (remote && path) {
      if (!transport) {
        // 无数据源：remote 产物要求注入 transport，未注入即配置/接线错误——
        // 从未发出任何网络请求，与下面 catch 里的「发了但失败」是完全不同的
        // 根因，不能共用同一句「产物已不存在或已变更」（真机验收缺陷 3：这句
        // 混淆过一次「打错了机器」和「文件真没了」，排查方向被带偏一整轮）。
        setErr("noSource");
        return;
      }
      transport
        .readArtifact(remote.sessionId, path)
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
        .catch((e: unknown) => {
          if (cancelled) return;
          // 保留原始 error（此前 `.catch(() => setErr(true))` 直接丢弃，排查
          // 只能靠猜）；文案按 remoteRejected/remoteUnreachable 细分。
          console.error("[ArtifactBody] 远程产物加载失败", e);
          setErr(classifyRemoteArtifactError(e));
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
      : // 本机产物源：经注入的 fetchLocal（path 在此分支必然有值）
        (fetchLocal?.(path ?? "", { isText }) ??
        Promise.reject(new Error("no local artifact source configured")));

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
      .catch((e: unknown) => {
        if (cancelled) return;
        // 本机 404 / 网盘 presigned 失效 / 网络错误统一归 notFound——都是
        // 「这个来源本身取不到内容」，与远程链路失败（transport 层面的拒绝/
        // 不可达）是不同性质的问题，不再共用同一条判断，但仍保留原始 error
        // 供控制台排查（此前直接丢弃）。
        console.error("[ArtifactBody] 本机产物加载失败", e);
        setErr("notFound");
      });
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
    // name 不直接用于 effect 内部（只影响 kind，kind 已在依赖中）
  }, [path, url, kind, remote, fetchLocal, transport]);

  return { blobUrl, text, err, tooLarge };
}

/**
 * 下载产物，支持三种来源：
 * - url 源（网盘 presigned）：直接设 a.href=url + a.download=name（presigned 自带凭证）
 * - remote 源（跨设备产物）：经注入的 `transport.readArtifact` 取 base64 → blob →
 *   a.download。too-large 场景无法内联下载，静默跳过（与 {@link ArtifactBody}
 *   的 tooLarge 态一致——下载入口在标题栏，看不到产物是否触发了 too-large，
 *   跳过优于误下载一个空/错误文件）。
 * - path 源（本机产物，`remote` 未传时）：经注入的 `fetchLocal` 取 blob → a.download
 *
 * 曾经的缺口（web-agent/web-main 两端右面板下载按钮共用本函数）：`remote` 存在时
 * 仍误用 `fetchLocal`（本机 apiClient）读取**对端**工作区相对路径，本机没有这个
 * 文件，恒 404/取到无关内容——本次显式拆出 remote 分支修复，remote 优先于
 * fetchLocal 判断，不会再误落到 fetchLocal 分支。
 */
export async function downloadArtifact(opts: {
  path?: string;
  url?: string;
  name?: string;
  fetchLocal?: FetchLocalArtifact;
  remote?: { deviceId: string; sessionId: string };
  transport?: ArtifactRemoteTransport;
}): Promise<void> {
  const { path, url, name, fetchLocal, remote, transport } = opts;
  const filename = name ?? path?.split("/").pop() ?? "file";

  if (url) {
    // presigned 直链下载，无需 fetchLocal
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    return;
  }

  if (path && remote) {
    if (!transport) return;
    const r = await transport.readArtifact(remote.sessionId, path);
    if (r.kind === "too-large") return;
    const bytes = base64ToBytes(r.base64);
    const blobUrl = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(blobUrl);
    return;
  }

  if (path && fetchLocal) {
    const data = await fetchLocal(path, { isText: false, download: true });
    const blob =
      data instanceof Blob ? data : new Blob([data], { type: "text/plain" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(blobUrl);
  }
}

function Loading({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

/**
 * 按类型分发渲染产物内容（preview 面板与全屏共用）。
 * 支持两种来源：
 * - path 源：经 `fetchLocal`（非 remote）或 `transport.readArtifact`（remote）拉取
 * - url + name 源：网盘 presigned，裸 fetch 自带凭证
 *
 * 从 `apps/web-agent/src/components/artifact/artifact-body.tsx` 迁入
 * （web-main 会话壳复用 Task 3）：数据读取从直连 apiClient / rest 函数改为
 * `fetchLocal`/`transport` 注入（web-common 禁 apiClient/next-intl/@\ 依赖）；
 * PDF 渲染改 `renderPdf` 注入（react-pdf 是 web-agent 专属依赖，不进 web-common）；
 * 文案改 `labels` 注入。保留 path/url/remote 三分支语义不变。
 */
export function ArtifactBody({
  path,
  url,
  name,
  remote,
  labels,
  fetchLocal,
  transport,
  renderPdf,
  onUploadedToDrive,
}: ArtifactBodyProps) {
  const kindTarget = path ?? name ?? "";
  const kind = artifactKind(kindTarget);
  const { blobUrl, text, err, tooLarge } = useArtifactContent(
    path,
    url,
    name,
    remote,
    fetchLocal,
    transport,
  );
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState(false);

  // 远程大产物：提示上传网盘预览；确认后 B 设备上传 → 调用方决定后续
  // （如取 presigned URL 切换预览来源）。
  if (tooLarge && remote && path) {
    const sizeMb = (tooLarge.size / 1024 / 1024).toFixed(1);
    const onUpload = async () => {
      if (!transport) return;
      setUploading(true);
      setUploadErr(false);
      try {
        const up = await transport.uploadArtifactToDrive(
          remote.sessionId,
          path,
        );
        await onUploadedToDrive?.(up);
      } catch {
        setUploadErr(true);
      } finally {
        setUploading(false);
      }
    };
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium text-foreground">
          {labels.tooLarge(sizeMb)}
        </p>
        {labels.tooLargeHint && (
          <p className="text-xs text-muted-foreground">{labels.tooLargeHint}</p>
        )}
        {uploadErr && (
          <p className="text-xs text-destructive">{labels.uploadFailed}</p>
        )}
        <button
          type="button"
          disabled={uploading}
          onClick={() => void onUpload()}
          className="rounded-md bg-(--shell-accent) px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-60"
        >
          {uploading ? labels.uploading : labels.uploadToDrive}
        </button>
      </div>
    );
  }

  if (err) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        {resolveLoadFailedText(labels, err)}
      </div>
    );
  }
  if (kind === "pdf") {
    if (!blobUrl) return <Loading text={labels.loading} />;
    if (renderPdf) {
      return <div className="h-full overflow-auto">{renderPdf(blobUrl)}</div>;
    }
    return (
      <iframe
        title={labels.previewTitle}
        src={blobUrl}
        className="h-full w-full border-0"
      />
    );
  }
  if (kind === "html") {
    if (text === null) return <Loading text={labels.loading} />;
    return (
      <iframe
        title={labels.previewTitle}
        srcDoc={text}
        sandbox=""
        className="h-full w-full border-0 bg-white"
      />
    );
  }
  if (kind === "image") {
    if (!blobUrl) return <Loading text={labels.loading} />;
    return (
      <div className="flex h-full items-center justify-center p-3">
        <img
          src={blobUrl}
          alt={labels.imageAlt}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }
  if (kind === "markdown") {
    return (
      <div className="px-4 py-3 text-sm">
        {text === null ? (
          <Loading text={labels.loading} />
        ) : (
          <MarkdownContent text={text} />
        )}
      </div>
    );
  }
  if (kind === "text") {
    return (
      <pre className="overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
        {text ?? labels.loading}
      </pre>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
      {labels.unsupported}
    </div>
  );
}
