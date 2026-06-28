"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue } from "jotai";
import { X } from "lucide-react";
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
  const [artifact, setArtifact] = useAtom(previewArtifactAtom);
  const name = useAtomValue(quickAssistantNameAtom);
  if (!artifact) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Tab active={type === "assistant"} onClick={() => setType("assistant")}>
        {name}
      </Tab>
      <span className="flex items-center">
        <Tab active={type === "preview"} onClick={() => setType("preview")}>
          预览
        </Tab>
        <button
          type="button"
          onClick={() => {
            setArtifact(null);
            setType("assistant");
          }}
          title="关闭预览"
          className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-black/10 hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
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
        "max-w-[160px] truncate rounded px-2 py-0.5 text-[13px] font-medium transition-colors",
        active
          ? "bg-black/5 text-foreground dark:bg-white/10"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
