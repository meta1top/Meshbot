"use client";

import { Button } from "@meshbot/design";
import { Check, Copy, KeyRound, Link2, Loader2, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  useCreateShareLink,
  useRevokeShareLink,
  useShareLinks,
} from "@/rest/drive";

interface DriveShareLinkModalProps {
  /** 被分享的节点 id。 */
  nodeId: string;
  /** 弹窗是否可见。 */
  open: boolean;
  /** 关闭回调。 */
  onClose: () => void;
}

/**
 * 网盘节点公开链接管理弹窗：
 * - 展示已有公开链接（可复制、撤销，带过期/加密标识）
 * - 支持新建链接（过期天数 + 可选密码）
 * - 关闭时重置表单状态
 */
export function DriveShareLinkModal({
  nodeId,
  open,
  onClose,
}: DriveShareLinkModalProps) {
  const t = useTranslations("drive");

  // —— 所有 hooks 必须在顶层，不能在 open 判断之后 ——
  const { data: links = [], isLoading } = useShareLinks(open ? nodeId : null);
  const createMutation = useCreateShareLink(nodeId);
  const revokeMutation = useRevokeShareLink(nodeId);

  // 新建区表单状态
  const [expiresInDays, setExpiresInDays] = useState<number | null>(7);
  const [password, setPassword] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  // 复制成功瞬态：记录刚复制的 linkId
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 关闭时重置表单状态（避免下次打开时残留）
  useEffect(() => {
    if (!open) {
      setExpiresInDays(7);
      setPassword("");
      setCreateError(null);
      setCopiedId(null);
    }
  }, [open]);

  // 渲染前：弹窗未开或 SSR 时不挂 portal
  if (!open || typeof document === "undefined") return null;

  /** 复制链接到剪贴板，短暂显示打勾状态。 */
  function handleCopy(link: { id: string; url: string }) {
    navigator.clipboard.writeText(link.url).then(() => {
      setCopiedId(link.id);
      setTimeout(
        () => setCopiedId((prev) => (prev === link.id ? null : prev)),
        2000,
      );
    });
  }

  /** 撤销指定链接。 */
  async function handleRevoke(linkId: string) {
    try {
      await revokeMutation.mutateAsync(linkId);
    } catch {
      // 撤销失败静默，列表会保持
    }
  }

  /** 创建新公开链接。 */
  async function handleCreate() {
    setCreateError(null);
    try {
      const body: { expiresInDays?: number | null; password?: string } = {
        expiresInDays,
      };

      if (password.trim()) {
        body.password = password.trim();
      }

      await createMutation.mutateAsync(body);
      setPassword("");
    } catch {
      setCreateError(t("shareLinkCreateError"));
    }
  }

  /** 将过期时间格式化为可读文案。 */
  function expiresLabel(expiresAt: string | null): string {
    if (!expiresAt) return t("shareLinkNeverExpires");
    const date = new Date(expiresAt);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays <= 0) return t("shareLinkExpired");
    if (diffDays === 1) return t("shareLinkExpiresIn1Day");
    return t("shareLinkExpiresInDays", { days: diffDays });
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("shareLinkTitle")}
        className="flex w-full max-w-[480px] flex-col gap-0 rounded-lg border border-border bg-background shadow-xl overflow-hidden"
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-[15px] font-semibold text-foreground">
              {t("shareLinkTitle")}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t("shareLinkCancel")}
            className="rounded p-0.5 hover:bg-muted text-muted-foreground transition-colors"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 已有链接列表 */}
        <div className="min-h-[80px] max-h-[220px] overflow-y-auto px-4 py-3">
          {isLoading ? (
            <div className="flex items-center justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : links.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("shareLinkEmpty")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold text-muted-foreground mb-1">
                {t("shareLinkCurrentTitle")}
              </p>
              {links.map((link) => (
                <div
                  key={link.id}
                  className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2"
                >
                  {/* URL 行 */}
                  <div className="flex items-center gap-1.5">
                    <input
                      readOnly
                      value={link.url}
                      className="flex-1 min-w-0 rounded border border-border/50 bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      aria-label={t("shareLinkCopy")}
                      className="shrink-0 rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => handleCopy(link)}
                    >
                      {copiedId === link.id ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={t("shareLinkRevoke")}
                      className="shrink-0 rounded p-1 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => void handleRevoke(link.id)}
                      disabled={revokeMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {/* 标识行：过期 + 加密 */}
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {expiresLabel(link.expiresAt)}
                    </span>
                    {link.requiresPassword && (
                      <span className="flex items-center gap-0.5 text-[11px] text-amber-500">
                        <KeyRound className="h-3 w-3" />
                        {t("shareLinkEncrypted")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 新建区 */}
        <div className="border-t border-border px-4 py-3 flex flex-col gap-2.5">
          <p className="text-xs font-semibold text-muted-foreground">
            {t("shareLinkCreateTitle")}
          </p>
          <div className="flex gap-2">
            {/* 过期时间下拉 */}
            <select
              value={expiresInDays === null ? "never" : String(expiresInDays)}
              onChange={(e) => {
                const v = e.target.value;
                setExpiresInDays(v === "never" ? null : Number(v));
              }}
              className="w-32 shrink-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="7">{t("shareLinkExpire7")}</option>
              <option value="30">{t("shareLinkExpire30")}</option>
              <option value="never">{t("shareLinkExpireNever")}</option>
            </select>

            {/* 可选密码 */}
            <input
              type="password"
              placeholder={t("shareLinkPasswordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={createMutation.isPending}
            />
          </div>

          {/* 错误提示 */}
          {createError && (
            <p className="text-[12px] text-destructive">{createError}</p>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={createMutation.isPending}
          >
            {t("shareLinkCancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleCreate()}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {t("shareLinkCreate")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
