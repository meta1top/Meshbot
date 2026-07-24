"use client";

import { Button } from "@meshbot/design";
import { useAtomValue } from "jotai";
import { Loader2, Share2, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { currentUserAtom } from "@/atoms/auth";
import { type DriveGrant, useGrants, useSetGrants } from "@/rest/drive";
import { useMembers } from "@/rest/org";

interface DriveShareModalProps {
  /** 被共享的节点 id。 */
  nodeId: string;
  /** 弹窗是否可见。 */
  open: boolean;
  /** 关闭回调。 */
  onClose: () => void;
}

/**
 * 网盘节点共享设置弹窗：
 * - 展示现有共享列表（grantee + 权限，可移除）
 * - 支持新增共享对象（整个组织 / 指定成员）并设置权限（viewer / editor）
 * - 确认后合并并调用 setGrants 全量覆盖
 */
export function DriveShareModal({
  nodeId,
  open,
  onClose,
}: DriveShareModalProps) {
  const t = useTranslations("drive");
  const user = useAtomValue(currentUserAtom);
  const orgId = user?.org?.id ?? null;

  // —— 所有 hooks 必须在顶层，不能在 open 判断之后 ——
  const { data: members = [] } = useMembers(orgId);
  const { data: existingGrants = [], isLoading: grantsLoading } = useGrants(
    open ? nodeId : null,
  );
  const setGrantsMutation = useSetGrants(nodeId);

  // 新增共享的表单状态
  const [shareWith, setShareWith] = useState<string>("org");
  const [permission, setPermission] = useState<"viewer" | "editor">("viewer");
  const [error, setError] = useState<string | null>(null);

  // 本地维护的「待移除」列表（granteeType+granteeId 的 key）
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(new Set());

  // 弹窗关闭时重置表单状态（避免下次打开时残留上次的选择）
  useEffect(() => {
    if (!open) {
      setRemovedKeys(new Set());
      setShareWith("org");
      setPermission("viewer");
      setError(null);
    }
  }, [open]);

  // 渲染前：弹窗未开或 SSR 时不挂 portal
  if (!open || typeof document === "undefined") return null;

  // 无 org 时提示不可共享
  if (!orgId) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div
          role="dialog"
          aria-modal="true"
          className="flex w-full max-w-[400px] flex-col gap-4 rounded-xl border border-border bg-background p-5 shadow-xl"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-foreground">
              {t("shareTitle")}
            </h2>
            <button
              type="button"
              aria-label={t("shareCancel")}
              className="rounded p-0.5 hover:bg-muted text-muted-foreground transition-colors"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-sm text-muted-foreground">{t("shareNoOrg")}</p>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t("shareCancel")}
            </Button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  /** 当前有效的 grant key（granteeType:granteeId）。 */
  function grantKey(g: DriveGrant): string {
    return `${g.granteeType}:${g.granteeId}`;
  }

  /** 移除某一授权（仅标记，提交时生效）。 */
  function removeGrant(key: string) {
    setRemovedKeys((prev) => new Set(prev).add(key));
  }

  /** 撤销移除。 */
  function restoreGrant(key: string) {
    setRemovedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  /** 构造新增 grant 对象。 */
  function buildNewGrant(): DriveGrant {
    if (shareWith === "org") {
      // orgId 在此处一定非 null（无 org 时已提前 return）
      return { granteeType: "org", granteeId: orgId as string, permission };
    }
    // "user:<userId>" 格式
    const userId = shareWith.replace(/^user:/, "");
    return { granteeType: "user", granteeId: userId, permission };
  }

  /** 提交：合并现有 + 新增（同 key 覆盖），过滤已删除，调 setGrants。 */
  async function handleConfirm() {
    setError(null);
    const newGrant = buildNewGrant();
    const newKey = grantKey(newGrant);

    // 从现有 grants 中过滤掉被移除的，剩余按 key 构建 map
    const base = new Map<string, DriveGrant>(
      existingGrants
        .filter((g) => !removedKeys.has(grantKey(g)))
        .map((g) => [grantKey(g), g]),
    );

    // 同 key 覆盖（新增的 permission 优先）
    base.set(newKey, newGrant);

    const merged = Array.from(base.values());
    try {
      await setGrantsMutation.mutateAsync(merged);
      onClose();
    } catch {
      setError(t("shareError"));
    }
  }

  // 下拉选项：整个组织 + 各成员
  const shareOptions: { value: string; label: string }[] = [
    { value: "org", label: t("shareWithOrg") },
    ...members.map((m) => ({
      value: `user:${m.userId}`,
      label: m.displayName ? `${m.displayName} (${m.email})` : m.email,
    })),
  ];

  /** 将 granteeType+granteeId 转为可读文案。 */
  function granteeLabel(g: DriveGrant): string {
    if (g.granteeType === "org") return t("shareWithOrg");
    const member = members.find((m) => m.userId === g.granteeId);
    if (member)
      return member.displayName
        ? `${member.displayName} (${member.email})`
        : member.email;
    return g.granteeId;
  }

  function permissionLabel(p: "viewer" | "editor"): string {
    return p === "editor" ? t("sharePermEditor") : t("sharePermViewer");
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("shareTitle")}
        className="flex w-full max-w-[440px] flex-col gap-0 rounded-xl border border-border bg-background shadow-xl overflow-hidden"
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Share2 className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-[15px] font-semibold text-foreground">
              {t("shareTitle")}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t("shareCancel")}
            className="rounded p-0.5 hover:bg-muted text-muted-foreground transition-colors"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 现有共享列表 */}
        <div className="min-h-[80px] max-h-[200px] overflow-y-auto px-4 py-3">
          {grantsLoading ? (
            <div className="flex items-center justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : existingGrants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("shareNoGrants")}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-muted-foreground mb-1">
                {t("shareCurrentTitle")}
              </p>
              {existingGrants.map((g) => {
                const key = grantKey(g);
                const removed = removedKeys.has(key);
                return (
                  <div
                    key={key}
                    className={`flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors ${removed ? "opacity-40 line-through" : "bg-muted/40"}`}
                  >
                    <span className="truncate text-foreground flex-1">
                      {granteeLabel(g)}
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {permissionLabel(g.permission)}
                    </span>
                    <button
                      type="button"
                      className="ml-2 shrink-0 rounded p-0.5 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={
                        removed ? t("shareRestore") : t("shareRemove")
                      }
                      onClick={() =>
                        removed ? restoreGrant(key) : removeGrant(key)
                      }
                    >
                      {removed ? (
                        <span className="text-[10px]">{t("shareRestore")}</span>
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 新增共享表单 */}
        <div className="border-t border-border px-4 py-3 flex flex-col gap-2.5">
          <p className="text-xs font-semibold text-muted-foreground">
            {t("shareAddTitle")}
          </p>
          <div className="flex gap-2">
            {/* 共享对象 */}
            <select
              value={shareWith}
              onChange={(e) => setShareWith(e.target.value)}
              className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {shareOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {/* 权限 */}
            <select
              value={permission}
              onChange={(e) =>
                setPermission(e.target.value as "viewer" | "editor")
              }
              className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="viewer">{t("sharePermViewer")}</option>
              <option value="editor">{t("sharePermEditor")}</option>
            </select>
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <p className="px-4 py-1 text-[12px] text-destructive">{error}</p>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={setGrantsMutation.isPending}
          >
            {t("shareCancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleConfirm}
            disabled={setGrantsMutation.isPending}
          >
            {setGrantsMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {t("shareConfirm")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
