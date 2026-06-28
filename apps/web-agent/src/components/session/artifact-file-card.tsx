"use client";

import { useSetAtom } from "jotai";
import { FileText } from "lucide-react";
import {
  assistantPanelOpenAtom,
  assistantPanelTypeAtom,
  previewArtifactAtom,
} from "@/atoms/assistant-panel";
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

/** present_file 的对话流文件框：点击在右侧 dock 打开预览。 */
export function ArtifactFileCard({ tool }: { tool: ToolCallView }) {
  const setType = useSetAtom(assistantPanelTypeAtom);
  const setArtifact = useSetAtom(previewArtifactAtom);
  const setOpen = useSetAtom(assistantPanelOpenAtom);

  const args = (tool.args ?? {}) as { path?: string; title?: string };
  const path = args.path ?? "";
  const name = args.title ?? path.split("/").pop() ?? "文件";
  const kind = artifactKind(path);

  const open = () => {
    if (!path) return;
    setArtifact({ path, title: args.title });
    setType("preview");
    setOpen(true);
  };

  return (
    <button
      type="button"
      onClick={open}
      className="flex w-full items-center gap-3 rounded-[8px] border border-border bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
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
