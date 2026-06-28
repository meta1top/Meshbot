"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  PanelLeft,
  Search,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  artifactFullscreenAtom,
  assistantPanelOpenAtom,
  sidebarDrawerOpenAtom,
} from "@/atoms/assistant-panel";

/**
 * 顶部全宽搜索栏（位于橙色 chrome 上）。左：（窄屏汉堡）+前进/后退；中：全局搜索（本期 UI 占位）；右：✦随手问 + 帮助。
 * 整条作为 Electron 拖拽区（.drag-handle），按钮 [data-no-drag]。
 */
export function ShellTopBar() {
  const router = useRouter();
  const t = useTranslations("appShell");
  const [panelOpen, setPanelOpen] = useAtom(assistantPanelOpenAtom);
  const setSidebarDrawerOpen = useSetAtom(sidebarDrawerOpenAtom);
  const fullscreen = useAtomValue(artifactFullscreenAtom);
  return (
    <div className="drag-handle flex h-[42px] shrink-0 items-center gap-2 bg-(--shell-chrome) px-3">
      <div className="app-mac-controls-safe-left flex items-center gap-0.5">
        {/* 窄屏（< md）汉堡：打开消息侧栏抽屉 */}
        <button
          type="button"
          data-no-drag
          onClick={() => setSidebarDrawerOpen((v) => !v)}
          aria-label={t("rail.messages")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white md:hidden"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-no-drag
          onClick={() => router.back()}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-no-drag
          onClick={() => router.forward()}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="mx-auto w-full max-w-[460px]">
        <div
          data-no-drag
          className="flex h-7 items-center gap-2 rounded-md bg-white/15 px-3 text-white/70"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="text-[12px]">{t("search.placeholder")}</span>
        </div>
      </div>
      {!fullscreen && (
        <button
          type="button"
          data-no-drag
          onClick={() => setPanelOpen((v) => !v)}
          title={t("assistant")}
          aria-label={t("assistant")}
          aria-pressed={panelOpen}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
            panelOpen
              ? "bg-(--shell-accent)/20 text-(--shell-accent)"
              : "text-white/65 hover:bg-white/10 hover:text-white",
          )}
        >
          <Sparkles className="h-4 w-4" />
        </button>
      )}
      <button
        type="button"
        data-no-drag
        className="flex h-7 w-7 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white"
      >
        <HelpCircle className="h-4 w-4" />
      </button>
    </div>
  );
}
