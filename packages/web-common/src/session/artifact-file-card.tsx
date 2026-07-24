import { cn } from "@meshbot/design";
import { FileText, FileWarning } from "lucide-react";
import { artifactKind } from "./artifact-kind";
import type { ToolCallView } from "./timeline";

const KIND_LABEL: Record<string, string> = {
  html: "网页",
  pdf: "PDF",
  image: "图片",
  markdown: "Markdown",
  text: "文本",
  binary: "文件",
};

/** ArtifactFileCard 的 i18n 文案（原仅 1 处 t() 调用，labels 化）。 */
export interface ArtifactFileCardLabels {
  presentFailed: string;
}

/** 预览目标：本地会话省略 remote；远程会话（跨设备）带对端设备/会话 id。 */
export interface ArtifactPreviewTarget {
  path: string;
  title?: string;
  remote?: { deviceId: string; sessionId: string };
}

export interface ArtifactFileCardProps {
  tool: ToolCallView;
  labels: ArtifactFileCardLabels;
  /** 当前会话所在的远程设备信息（本地会话为 null/undefined）。 */
  remote?: { deviceId: string; sessionId: string } | null;
  /** 点击卡片：调用方负责实际打开预览（写 atom / 换面板等）。 */
  onPreview: (target: ArtifactPreviewTarget) => void;
}

/**
 * 解析 present_file 工具结果：成功返回后端归一化的工作区相对路径 + 文件名；
 * 失败（`Error: ...` 文本 / 意外形态）返回 null。
 */
function parsePresented(
  result: string | undefined,
): { path: string; name?: string } | null {
  if (!result) return null;
  try {
    const p = JSON.parse(result) as {
      status?: unknown;
      path?: unknown;
      name?: unknown;
    };
    if (p.status === "presented" && typeof p.path === "string") {
      return {
        path: p.path,
        name: typeof p.name === "string" ? p.name : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * present_file 的对话流文件框：点击回调化交由调用方打开预览（本地会话/远程会话
 * 预览面板由各自宿主决定，本组件不感知）。
 *
 * 从 `apps/web-agent/src/components/session/artifact-file-card.tsx` 迁入
 * （Task 8）：`previewArtifactAtom`（jotai）→ `onPreview` 回调；
 * `useRemoteSession()` 的 remoteDeviceId/sessionId → `remote` prop；
 * `useTranslations("session.artifact")` 的唯一一处 t() → `labels.presentFailed`。
 *
 * - 成功：预览用**结果 JSON 的工作区相对路径**（后端已归一/校验），不用 LLM
 *   原始入参——绝对路径入参即使呈现成功，直传预览也可能出工作区边界。
 * - 失败（工具返回 Error 文本，如路径在工作区外）：渲染不可点击的降级行，
 *   避免给用户一张永远打不开的「点击预览」卡。
 * - 运行中（无结果）：沿用入参渲染占位卡。
 */
export function ArtifactFileCard({
  tool,
  labels,
  remote,
  onPreview,
}: ArtifactFileCardProps) {
  const args = (tool.args ?? {}) as { path?: string; title?: string };
  const presented = parsePresented(tool.result);
  const failed = !!tool.result && !presented;
  const previewPath = presented?.path ?? args.path ?? "";
  const name =
    args.title ?? presented?.name ?? previewPath.split("/").pop() ?? "文件";
  const kind = artifactKind(previewPath);

  if (failed) {
    const detail = (tool.result ?? "").split("\n")[0].slice(0, 120);
    return (
      <div className="flex w-full items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FileWarning className="h-4.5 w-4.5" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-muted-foreground">
            {name}
          </span>
          <span className="truncate text-xs text-muted-foreground/70">
            {labels.presentFailed}
            {detail && ` · ${detail}`}
          </span>
        </span>
      </div>
    );
  }

  const open = () => {
    if (!previewPath) return;
    onPreview({
      path: previewPath,
      title: args.title,
      remote: remote ?? undefined,
    });
  };

  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-(--shell-accent)/12 text-(--shell-accent)">
        <FileText className="h-4.5 w-4.5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {name}
        </span>
        <span className="text-xs text-muted-foreground">
          {KIND_LABEL[kind]} · 点击预览
        </span>
      </span>
    </button>
  );
}
