"use client";
import { useAtom, useAtomValue } from "jotai";
import { Sparkles, X } from "lucide-react";
import { useEffect } from "react";
import {
  assistantPanelOpenAtom,
  quickAssistantNameAtom,
} from "@/atoms/assistant-panel";
import { AssistantDock } from "@/components/im/assistant-dock";

/** 随手问：右下角浮动气泡,点击展开成锚定右下的浮动面板(内容=AssistantDock chromeless)。 */
export function QuickAssistantFab() {
  const [open, setOpen] = useAtom(assistantPanelOpenAtom);
  const name = useAtomValue(quickAssistantNameAtom);
  // 展开态按 ESC 收起面板（与 X 按钮同义），无展开时不挂监听。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={name}
        title={name}
        className="absolute right-4 bottom-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-(--shell-accent) text-white shadow-lg shadow-(--shell-accent)/30 transition-transform hover:scale-105"
      >
        <Sparkles className="h-5 w-5" />
      </button>
    );
  }
  return (
    <div className="absolute right-4 bottom-4 z-40 flex h-[560px] max-h-[calc(100%-2rem)] w-[380px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-(--shell-radius) border border-border bg-(--shell-content) shadow-2xl">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Sparkles className="h-4 w-4 text-(--shell-accent)" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {name}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="close"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AssistantDock chromeless />
      </div>
    </div>
  );
}
