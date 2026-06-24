"use client";

import { Button } from "@meshbot/design";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmText: string;
  cancelText: string;
  /** 确认请求进行中：按钮 disabled + spinner，Esc 不再关闭。 */
  loading?: boolean;
  /** 危险操作（删除等）：确认按钮用 destructive 红色。 */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 全局统一确认框。
 *
 * 关键：用 createPortal 渲染到 document.body —— 否则在带 transform 的祖先
 * （如响应式侧栏 aside 的 translate-x）内，`fixed` 会以该祖先为包含块、被裁在侧栏里。
 * 挂到 body 后 `fixed inset-0` 才真正相对视口居中。
 *
 * 行为：Esc 关闭（loading 时禁用）；遮罩点击 *不* 关闭（避免 dropdown 关闭时
 * focus 恢复导致的遮罩误触）。按钮用 design 系统 Button，风格全局统一。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText,
  cancelText,
  loading,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open || loading) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onCancel]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        className="flex w-full max-w-[400px] flex-col gap-3 rounded-lg border border-border bg-background p-5 shadow-xl"
      >
        <div className="text-[15px] font-semibold text-foreground">{title}</div>
        {description && (
          <div className="text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </div>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelText}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            size="sm"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
