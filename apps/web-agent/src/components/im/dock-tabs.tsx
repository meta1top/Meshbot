"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import {
  assistantPanelTypeAtom,
  previewArtifactAtom,
  quickAssistantNameAtom,
} from "@/atoms/assistant-panel";

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
  const previewLabel =
    artifact.title ?? artifact.path.split("/").pop() ?? "预览";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Tab active={type === "assistant"} onClick={() => setType("assistant")}>
        {name}
      </Tab>
      <Tab active={type === "preview"} onClick={() => setType("preview")}>
        {previewLabel}
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
        "max-w-[140px] truncate rounded px-2 py-0.5 text-[13px] font-medium transition-colors",
        active
          ? "bg-black/5 text-foreground dark:bg-white/10"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
