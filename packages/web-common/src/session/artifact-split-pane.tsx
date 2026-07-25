"use client";

import { cn } from "@meshbot/design";
import { Download, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  ArtifactBody,
  type ArtifactBodyLabels,
  type ArtifactRemoteTransport,
  downloadArtifact,
  type FetchLocalArtifact,
} from "./artifact-body";

/** 预览目标：本机产物用 path，网盘产物用 url+name，远程设备产物额外带 remote。 */
export interface ArtifactSplitPaneTarget {
  path?: string;
  url?: string;
  name?: string;
  remote?: { deviceId: string; sessionId: string };
  title?: string;
}

export interface ArtifactSplitPaneLabels {
  /** 无预览目标时的占位文案。 */
  empty: string;
  /** 标题栏兜底标题（target 无 title/name/path 文件名时）。 */
  untitled: string;
  download: string;
  close: string;
  /** 转发给 {@link ArtifactBody} 的文案。 */
  body: ArtifactBodyLabels;
}

/**
 * 计算标题栏文案：target.title → name → path 文件名 → 兜底 untitled。
 * 从原自绘标题栏拆出的纯函数——web-agent 迁 UnifiedSheet 后直接传字符串给
 * `title` 槽（走底座默认排版）；web-main 仍自绘标题栏，同样调用它取文案。
 */
export function getArtifactSplitPaneTitle(
  target: ArtifactSplitPaneTarget | null,
  untitledLabel: string,
): string {
  if (!target) return untitledLabel;
  return (
    target.title ??
    target.name ??
    target.path?.split("/").pop() ??
    untitledLabel
  );
}

export interface ArtifactSplitPaneActionsProps {
  target: ArtifactSplitPaneTarget | null;
  onClose: () => void;
  labels: Pick<ArtifactSplitPaneLabels, "download" | "close" | "untitled">;
  fetchLocal?: FetchLocalArtifact;
  transport?: ArtifactRemoteTransport;
  /** 按钮 className 扩展（web-agent 装配壳加 `app-no-drag` 类，避免拖拽区吞按钮点击；web-main 默认不带）。 */
  className?: string;
}

/**
 * 产物工具栏动作（下载 + 关闭）：从原自绘标题栏拆出，供 web-agent 迁 UnifiedSheet
 * 后的 `headerActions` 槽、web-main 自绘标题栏共用。
 */
export function ArtifactSplitPaneActions({
  target,
  onClose,
  labels,
  fetchLocal,
  transport,
  className,
}: ArtifactSplitPaneActionsProps) {
  if (!target) return null;
  const title = getArtifactSplitPaneTitle(target, labels.untitled);
  return (
    <>
      <button
        type="button"
        title={labels.download}
        onClick={() =>
          void downloadArtifact({
            path: target.path,
            url: target.url,
            name: title,
            fetchLocal,
            remote: target.remote,
            transport,
          })
        }
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
          className,
        )}
      >
        <Download className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title={labels.close}
        onClick={onClose}
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
          className,
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

export interface ArtifactSplitPaneProps {
  target: ArtifactSplitPaneTarget | null;
  labels: Pick<ArtifactSplitPaneLabels, "empty" | "body">;
  fetchLocal?: FetchLocalArtifact;
  transport?: ArtifactRemoteTransport;
  renderPdf?: (blobUrl: string) => ReactNode;
  onUploadedToDrive?: (result: {
    fileId: string;
    name: string;
  }) => void | Promise<void>;
}

/**
 * 产物中区分栏正文：{@link ArtifactBody}。标题栏（标题文案 + 下载/关闭按钮）已
 * 拆到 {@link getArtifactSplitPaneTitle} / {@link ArtifactSplitPaneActions}——
 * web-agent 迁 UnifiedSheet 统一标题栏后，本组件只剩正文，直接作 UnifiedSheet
 * 的 children；web-main 未迁底座，仍自己拼一条标题栏 div，复用上面两个 slot。
 *
 * `target`/`onClose` 由调用方注入（web-agent 桥 `previewArtifactAtom`；
 * web-main 桥自己的预览 state）。
 */
export function ArtifactSplitPane({
  target,
  labels,
  fetchLocal,
  transport,
  renderPdf,
  onUploadedToDrive,
}: ArtifactSplitPaneProps) {
  if (!target) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        {labels.empty}
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <ArtifactBody
        path={target.path}
        url={target.url}
        name={target.name}
        remote={target.remote}
        labels={labels.body}
        fetchLocal={fetchLocal}
        transport={transport}
        renderPdf={renderPdf}
        onUploadedToDrive={onUploadedToDrive}
      />
    </div>
  );
}
