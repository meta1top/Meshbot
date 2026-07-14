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

export interface ArtifactSplitPaneProps {
  target: ArtifactSplitPaneTarget | null;
  onClose: () => void;
  labels: ArtifactSplitPaneLabels;
  fetchLocal?: FetchLocalArtifact;
  transport?: ArtifactRemoteTransport;
  renderPdf?: (blobUrl: string) => ReactNode;
  onUploadedToDrive?: (result: {
    fileId: string;
    name: string;
  }) => void | Promise<void>;
  /** 标题栏容器 className 扩展（web-agent 装配壳加 Electron `drag-handle` 类；web-common 默认不带）。 */
  titleBarClassName?: string;
  /** 工具按钮 className 扩展（web-agent 装配壳加 `app-no-drag` 类，避免拖拽区吞按钮点击）。 */
  actionButtonClassName?: string;
}

/**
 * 产物中区分栏正文：工具栏（标题/下载/关闭）+ {@link ArtifactBody}。纯展示，
 * `target`/`onClose` 由调用方注入（web-agent 桥 `previewArtifactAtom`；
 * web-main 桥自己的预览 state）。
 *
 * 从 `apps/web-agent/src/components/artifact/artifact-split-pane.tsx` 迁入
 * （web-main 会话壳复用 Task 3）：`previewArtifactAtom`/`useTranslations`
 * 改 `target`/`labels` 注入；Electron 拖拽区类名（`drag-handle`/`app-no-drag`）
 * 改 `titleBarClassName`/`actionButtonClassName` 注入，web-common 本体不带
 * Electron 专属类。
 */
export function ArtifactSplitPane({
  target,
  onClose,
  labels,
  fetchLocal,
  transport,
  renderPdf,
  onUploadedToDrive,
  titleBarClassName,
  actionButtonClassName,
}: ArtifactSplitPaneProps) {
  if (!target) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        {labels.empty}
      </div>
    );
  }
  const title =
    target.title ??
    target.name ??
    target.path?.split("/").pop() ??
    labels.untitled;
  return (
    <div className="flex h-full flex-col bg-(--shell-content)">
      {/* 标题栏拖拽区结构性拆分：drag 只包标题文字区，按钮组在 drag 容器外。
          面板 aside 常驻 DOM 靠 transform 滑入——transform 不触发布局变化，
          Electron 不重算 draggable regions，收起态被裁剪时按钮的 no-drag 洞
          可能未登记（首次点击被吞，点正文触发重算才恢复）。按钮不进 drag
          矩形就不依赖洞的登记时序（web-agent 经 titleBarClassName/
          actionButtonClassName 注入实际的 Electron 拖拽类）。 */}
      <div className="flex h-13 shrink-0 items-center border-b border-border">
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 items-center px-3",
            titleBarClassName,
          )}
        >
          <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2 pr-3">
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
              actionButtonClassName,
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
              actionButtonClassName,
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
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
    </div>
  );
}
