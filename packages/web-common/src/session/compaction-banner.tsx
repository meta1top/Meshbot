"use client";

export interface CompactionBannerLabels {
  bannerThreshold: string;
  bannerCtxExceeded: string;
}

export interface CompactionBannerProps {
  visible: boolean;
  reason?: "threshold" | "ctx-exceeded";
  labels: CompactionBannerLabels;
}

/**
 * Session 顶部的"会话历史压缩中"提示条。
 *
 * 从 `apps/web-agent/src/components/common/compaction-banner.tsx` 迁入
 * （Task 9 骨干批，随 `SessionConversationView` 一并迁移——该视图渲染结构里
 * 唯一消费方）。`useTranslations` 改 `labels` props。
 *
 * visible=true 时显示；reason 决定文案细微差别。
 */
export function CompactionBanner({
  visible,
  reason,
  labels,
}: CompactionBannerProps) {
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
          ? labels.bannerCtxExceeded
          : labels.bannerThreshold}
      </span>
    </div>
  );
}
