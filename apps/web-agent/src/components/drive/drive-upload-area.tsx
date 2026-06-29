"use client";

import { Progress } from "@meshbot/design";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, UploadCloud, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import {
  completeUpload,
  driveNodesQueryKey,
  requestUpload,
} from "@/rest/drive";

/** 单个文件的上传状态。 */
interface FileUploadState {
  /** 文件原始名称。 */
  name: string;
  /** 上传进度（0-100，-1 表示失败）。 */
  progress: number;
  /** 是否已完成。 */
  done: boolean;
  /** 失败信息，null 表示成功或未完成。 */
  error: string | null;
}

/**
 * presigned 两阶段直传单文件到 Minio。
 * 1. 向 server-main 申请 presigned PUT URL + nodeId；
 * 2. 用裸 fetch 直传文件到 Minio（不经 apiClient，不带 JWT）；
 * 3. 通知 server-main 完成。
 */
async function uploadOne(
  file: File,
  parentId: string | null,
  onProgress: (pct: number) => void,
): Promise<void> {
  const { nodeId, putUrl } = await requestUpload({
    name: file.name,
    parentId,
    size: file.size,
    mime: file.type || "application/octet-stream",
  });

  const put = await fetch(putUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!put.ok) throw new Error("上传失败");

  onProgress(90);
  await completeUpload(nodeId);
  onProgress(100);
}

/**
 * 网盘上传区：提供隐藏 file input（可被父组件通过 ref 触发），
 * 以及拖拽到任意区域时的悬浮上传反馈。
 * 同时渲染当前批次的上传进度列表（上方浮动卡片）。
 */
export function DriveUploadArea({
  parentId,
  inputRef,
}: {
  /** 当前所在目录；null 表示根目录。 */
  parentId: string | null;
  /** 外部通过此 ref 调用 input.click() 触发文件选择弹窗。 */
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const t = useTranslations("drive");
  const qc = useQueryClient();

  /** 当前批次所有文件的上传状态映射（文件名 → 状态）。 */
  const [uploads, setUploads] = useState<Record<string, FileUploadState>>({});

  /** 是否有文件正在拖拽悬停。 */
  const [dragging, setDragging] = useState(false);

  const dragCounterRef = useRef(0);

  /** 更新单个文件的进度/状态。 */
  function patchUpload(name: string, patch: Partial<FileUploadState>) {
    setUploads((prev) => ({
      ...prev,
      [name]: { ...prev[name], ...patch },
    }));
  }

  /** 上传一批文件（并发）。 */
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;

    // 初始化所有文件状态
    setUploads((prev) => {
      const next = { ...prev };
      for (const f of files) {
        next[f.name] = { name: f.name, progress: 0, done: false, error: null };
      }
      return next;
    });

    const results = await Promise.allSettled(
      files.map((file) =>
        uploadOne(file, parentId, (pct) =>
          patchUpload(file.name, { progress: pct }),
        ).then(() => {
          patchUpload(file.name, { progress: 100, done: true });
        }),
      ),
    );

    // 标记失败项
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        patchUpload(files[i].name, {
          error:
            result.reason instanceof Error ? result.reason.message : "上传失败",
          progress: -1,
        });
      }
    });

    // 刷新文件列表
    await qc.invalidateQueries({ queryKey: driveNodesQueryKey });
  }

  /** input change 事件处理。 */
  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // 重置 input value，允许重复选择同名文件
    e.target.value = "";
    uploadFiles(files);
  }

  /** 全局拖拽进入。 */
  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setDragging(true);
  }

  /** 全局拖拽离开。 */
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setDragging(false);
  }

  /** 全局拖拽 over（必须 preventDefault 才能触发 drop）。 */
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  /** 全局 drop：提取文件并上传。 */
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    uploadFiles(files);
  }

  const uploadList = Object.values(uploads);
  const hasUploads = uploadList.length > 0;
  const allDone = uploadList.every((u) => u.done || u.error !== null);

  return (
    <div
      role="region"
      aria-label="上传区域"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className="contents"
    >
      {/* 隐藏的 file input，通过 inputRef 由父组件触发 */}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />

      {/* 拖拽悬停蒙层 */}
      {dragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary p-12 text-primary">
            <UploadCloud className="h-12 w-12" />
            <p className="text-lg font-medium">{t("dropHint")}</p>
          </div>
        </div>
      )}

      {/* 上传进度浮动卡片 */}
      {hasUploads && (
        <div className="fixed bottom-6 right-6 z-40 w-72 rounded-xl border bg-background shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="text-sm font-medium">
              {allDone ? t("uploadDone") : t("uploading")}
            </span>
            {allDone && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setUploads({})}
              >
                {t("dismiss")}
              </button>
            )}
          </div>
          <ul className="max-h-60 overflow-y-auto divide-y">
            {uploadList.map((u) => (
              <li key={u.name} className="flex flex-col gap-1 px-4 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm" title={u.name}>
                    {u.name}
                  </span>
                  {u.done && !u.error && (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                  )}
                  {u.error && (
                    <XCircle
                      className="h-4 w-4 shrink-0 text-destructive"
                      aria-label={u.error}
                    />
                  )}
                  {!u.done && !u.error && (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                  )}
                </div>
                {!u.done && !u.error && (
                  <Progress value={u.progress} className="h-1.5" />
                )}
                {u.error && (
                  <p className="text-xs text-destructive">{u.error}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
