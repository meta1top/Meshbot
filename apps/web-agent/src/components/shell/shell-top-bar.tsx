"use client";

import { ChevronLeft, ChevronRight, HelpCircle, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * 顶部全宽搜索栏（位于橙色 chrome 上）。左：前进/后退；中：全局搜索（本期 UI 占位）；右：帮助。
 * 整条作为 Electron 拖拽区（.drag-handle），按钮 [data-no-drag]。
 */
export function ShellTopBar() {
  const router = useRouter();
  const t = useTranslations("appShell");
  return (
    <div className="drag-handle flex h-[42px] shrink-0 items-center gap-2 bg-(--shell-chrome) px-3">
      <div className="app-mac-controls-safe-left flex items-center gap-0.5">
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
