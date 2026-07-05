"use client";

import { cn } from "@meshbot/design";
import { useSetAtom } from "jotai";
import { FileText, FileWarning } from "lucide-react";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { artifactKind } from "@/lib/artifact";
import type { ToolCallView } from "./message-list";

const KIND_LABEL: Record<string, string> = {
  html: "网页",
  pdf: "PDF",
  image: "图片",
  markdown: "Markdown",
  text: "文本",
  binary: "文件",
};

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
 * present_file 的对话流文件框：点击在右侧 dock 打开预览。
 *
 * - 成功：预览用**结果 JSON 的工作区相对路径**（后端已归一/校验），不用 LLM
 *   原始入参——绝对路径入参即使呈现成功，直传预览也可能出工作区边界。
 * - 失败（工具返回 Error 文本，如路径在工作区外）：渲染不可点击的降级行，
 *   避免给用户一张永远打不开的「点击预览」卡。
 * - 运行中（无结果）：沿用入参渲染占位卡。
 */
export function ArtifactFileCard({ tool }: { tool: ToolCallView }) {
  const t = useTranslations("session.artifact");
  const setArtifact = useSetAtom(previewArtifactAtom);

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
      <div className="flex w-full items-center gap-3 rounded-[8px] border border-border bg-muted/30 px-3 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FileWarning className="h-4.5 w-4.5" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-muted-foreground">
            {name}
          </span>
          <span className="truncate text-xs text-muted-foreground/70">
            {t("presentFailed")}
            {detail && ` · ${detail}`}
          </span>
        </span>
      </div>
    );
  }

  const open = () => {
    if (!previewPath) return;
    setArtifact({ path: previewPath, title: args.title });
  };

  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        "flex w-full items-center gap-3 rounded-[8px] border border-border bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
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
