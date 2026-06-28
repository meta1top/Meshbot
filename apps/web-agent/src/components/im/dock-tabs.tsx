"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import {
  assistantPanelTypeAtom,
  previewArtifactAtom,
  quickAssistantNameAtom,
} from "@/atoms/assistant-panel";
import { artifactIcon } from "@/lib/artifact-icon";

/**
 * dock 顶部 tab 栏：助手 ⇄ 预览。仅在有预览产物时渲染（否则各面板用各自标题栏）。
 * 点 tab 切 panelType；当前面板高亮。
 */
export function DockTabs() {
  const [type, setType] = useAtom(assistantPanelTypeAtom);
  const artifact = useAtomValue(previewArtifactAtom);
  const name = useAtomValue(quickAssistantNameAtom);
  if (!artifact) {
    return null;
  }
  const PreviewIcon = artifactIcon(artifact.path);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Tab active={type === "assistant"} onClick={() => setType("assistant")}>
        <span className="truncate">{name}</span>
      </Tab>
      <Tab active={type === "preview"} onClick={() => setType("preview")}>
        <PreviewIcon className="h-3.5 w-3.5 shrink-0" />
        <span>预览</span>
      </Tab>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex max-w-[160px] items-center gap-1 rounded px-2 py-0.5 text-[13px] font-medium transition-colors",
        active
          ? "bg-black/5 text-foreground dark:bg-white/10"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
