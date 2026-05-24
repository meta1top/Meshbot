"use client";

import { cn } from "@meshbot/design";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

interface Props {
  open: boolean;
  title: string;
  /** 删除请求进行中。true 时按钮 disabled + 显示 spinner，且 Esc / 遮罩不再关闭。 */
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 删除确认 dialog。固定居中遮罩 + 简单文案 + 两按钮。
 * - Esc 关闭（loading 时禁用）
 * - 「取消」按钮关闭
 * - 遮罩点击 *不* 取消 —— 之前发现 dropdown menu 关闭时的 focus 恢复会让
 *   遮罩第一次点击误触，要求点两次「删除」，所以干脆禁用遮罩误触
 * - 「删除」按钮在 loading 期间禁用 + 显示 spinner
 */
export function SessionDeleteDialog({
  open,
  title,
  loading,
  onCancel,
  onConfirm,
}: Props) {
  const t = useTranslations("appShell.deleteConfirm");
  useEffect(() => {
    if (!open || loading) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
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
            disabled={loading}
            className="border border-border px-3 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="flex items-center gap-1.5 bg-destructive px-3 py-1 text-xs text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
          >
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
            {t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
