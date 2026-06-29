"use client";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from "@meshbot/design";
import { useEffect, useState } from "react";

/** server-main API base。空串 = 相对路径（同域反代），部署时配置 NEXT_PUBLIC_SERVER_MAIN_URL。 */
const API_BASE = process.env.NEXT_PUBLIC_SERVER_MAIN_URL ?? "";

/** 分享元信息（GET /api/share/:token 响应的 data 字段）。 */
interface ShareInfo {
  name: string;
  sizeBytes: number;
  mime: string;
  requiresPassword: boolean;
}

/** 下载凭证（POST /api/share/:token/download 响应的 data 字段）。 */
interface DownloadResult {
  url: string;
  name: string;
  mime: string;
}

/** 格式化字节数为可读字符串。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 解包服务端统一 envelope `{ success, data, message, code }`。 */
function unwrap(body: unknown): unknown {
  if (
    body !== null &&
    typeof body === "object" &&
    "success" in body &&
    "data" in body
  ) {
    const env = body as {
      success: unknown;
      code?: unknown;
      message?: unknown;
      data: unknown;
    };
    if (env.success === false) {
      const code = typeof env.code === "number" ? env.code : undefined;
      const message =
        typeof env.message === "string" && env.message
          ? env.message
          : "请求失败";
      const err = new Error(message) as Error & { code?: number };
      err.code = code;
      throw err;
    }
    return env.data;
  }
  return body;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "needPassword"; info: ShareInfo }
  | { kind: "ready"; info: ShareInfo; download: DownloadResult };

interface ShareViewProps {
  /** 分享链接 token，由 URL 路径参数传入。 */
  token: string;
}

/**
 * 网盘公开分享匿名页 client component。
 *
 * 状态机：loading → invalid | needPassword | ready
 * - invalid：链接失效 / 过期 / 撤销，显示友好提示。
 * - needPassword：需要密码，显示输入框。
 * - ready：显示预览（图片/PDF 内联）或下载按钮。
 */
export function ShareView({ token }: ShareViewProps) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 挂载时拉取分享元信息
  useEffect(() => {
    let cancelled = false;
    async function fetchInfo() {
      try {
        const res = await fetch(`${API_BASE}/api/share/${token}`);
        const json = (await res.json()) as unknown;
        if (!res.ok) {
          if (!cancelled) setState({ kind: "invalid" });
          return;
        }
        const data = unwrap(json) as ShareInfo;
        if (cancelled) return;
        if (data.requiresPassword) {
          setState({ kind: "needPassword", info: data });
        } else {
          // 无需密码，直接请求下载凭证
          await requestDownload(data, "");
        }
      } catch {
        if (!cancelled) setState({ kind: "invalid" });
      }
    }

    async function requestDownload(info: ShareInfo, pwd: string) {
      try {
        const res = await fetch(`${API_BASE}/api/share/${token}/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd }),
        });
        const json = (await res.json()) as unknown;
        if (!res.ok) {
          if (!cancelled) setState({ kind: "invalid" });
          return;
        }
        const dl = unwrap(json) as DownloadResult;
        if (!cancelled) setState({ kind: "ready", info, download: dl });
      } catch {
        if (!cancelled) setState({ kind: "invalid" });
      }
    }

    fetchInfo();
    return () => {
      cancelled = true;
    };
  }, [token]);

  /** 提交密码，请求下载凭证。 */
  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state.kind !== "needPassword") return;
    setSubmitting(true);
    setPasswordError("");
    try {
      const res = await fetch(`${API_BASE}/api/share/${token}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = (await res.json()) as unknown;
      if (!res.ok) {
        // 密码错误或其它错误
        let msg = "密码错误，请重试";
        try {
          const env = json as {
            success?: unknown;
            message?: unknown;
            code?: unknown;
          };
          if (typeof env.message === "string" && env.message) msg = env.message;
        } catch {
          // ignore
        }
        setPasswordError(msg);
        return;
      }
      const dl = unwrap(json) as DownloadResult;
      setState({ kind: "ready", info: state.info, download: dl });
    } catch {
      setPasswordError("网络错误，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-muted-foreground text-sm">加载中…</p>
      </main>
    );
  }

  if (state.kind === "invalid") {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>链接已失效</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              该分享链接已失效、撤销或已过期，请联系分享者重新获取。
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (state.kind === "needPassword") {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{state.info.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4 text-sm">
              该文件受密码保护，请输入访问密码后继续。
            </p>
            <form
              onSubmit={handlePasswordSubmit}
              className="flex flex-col gap-3"
            >
              <Input
                type="password"
                placeholder="输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                autoFocus
              />
              {passwordError && (
                <p className="text-destructive text-sm">{passwordError}</p>
              )}
              <Button type="submit" disabled={submitting || !password}>
                {submitting ? "验证中…" : "确认"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  // state.kind === "ready"
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <FilePreview info={state.info} download={state.download} />
    </main>
  );
}

/** 触发文件下载（临时创建 anchor，避免 DOM 残留）。 */
function triggerDownload(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** 根据 mime 类型渲染预览或下载按钮。 */
function FilePreview({
  info,
  download,
}: {
  info: ShareInfo;
  download: DownloadResult;
}) {
  if (download.mime.startsWith("image/")) {
    return (
      <div className="flex w-full max-w-3xl flex-col items-center gap-4">
        <p className="text-muted-foreground text-sm">
          {info.name}（{formatBytes(info.sizeBytes)}）
        </p>
        {/* biome-ignore lint/performance/noImgElement: 预览图不需要 next/image 优化（来自外部 presigned URL） */}
        <img
          src={download.url}
          alt={info.name}
          className="max-h-[80vh] max-w-full rounded-lg object-contain shadow"
        />
        <Button
          variant="outline"
          onClick={() => triggerDownload(download.url, download.name)}
        >
          下载
        </Button>
      </div>
    );
  }

  if (download.mime === "application/pdf") {
    return (
      <div className="flex w-full max-w-5xl flex-col items-center gap-4">
        <p className="text-muted-foreground text-sm">
          {info.name}（{formatBytes(info.sizeBytes)}）
        </p>
        <iframe
          src={download.url}
          title={info.name}
          className="h-[80vh] w-full rounded-lg border shadow"
        />
        <Button
          variant="outline"
          onClick={() => triggerDownload(download.url, download.name)}
        >
          下载
        </Button>
      </div>
    );
  }

  // 其它类型：显示文件名/大小 + 下载按钮
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{info.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">
          大小：{formatBytes(info.sizeBytes)}
        </p>
        <Button onClick={() => triggerDownload(download.url, download.name)}>
          下载文件
        </Button>
      </CardContent>
    </Card>
  );
}
