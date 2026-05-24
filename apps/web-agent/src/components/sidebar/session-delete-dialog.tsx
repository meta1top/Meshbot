"use client";

import { cn } from "@meshbot/design";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

interface Props {
  open: boolean;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 删除确认 dialog。固定居中遮罩 + 简单文案 + 两按钮。
 * 不引入新依赖：design 包当前的 AlertDialog 若可用应优先用之；这里先内联，
 * 后续统一对齐 design 包再替换。Esc / 遮罩点击关闭。
 */
export function SessionDeleteDialog({
  open,
  title,
  onCancel,
  onConfirm,
}: Props) {
  const t = useTranslations("appShell.deleteConfirm");
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label="close"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          "flex w-[360px] flex-col gap-3 border border-border bg-background p-4 shadow-lg",
        )}
      >
        <div className="text-sm font-medium text-foreground">
          {t("title", { title })}
        </div>
        <div className="text-xs text-muted-foreground">{t("description")}</div>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border border-border px-3 py-1 text-xs hover:bg-foreground/5"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-destructive px-3 py-1 text-xs text-destructive-foreground hover:bg-destructive/90"
          >
            {t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
