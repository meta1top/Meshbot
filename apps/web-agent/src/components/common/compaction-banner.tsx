"use client";

import { useTranslations } from "next-intl";

interface CompactionBannerProps {
  visible: boolean;
  reason?: "threshold" | "ctx-exceeded";
}

/**
 * Session 顶部的"会话历史压缩中"提示条。
 *
 * visible=true 时显示；reason 决定文案细微差别。
 */
export function CompactionBanner({ visible, reason }: CompactionBannerProps) {
  const t = useTranslations("session.compaction");
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
    >
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary/70" />
      <span>
        {reason === "ctx-exceeded"
          ? t("bannerCtxExceeded")
          : t("bannerThreshold")}
      </span>
    </div>
  );
}
