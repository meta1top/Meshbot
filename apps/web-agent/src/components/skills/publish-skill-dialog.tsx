"use client";

import type { InstalledSkill } from "@meshbot/types-agent";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { publishSkill } from "@/rest/skills";

interface Props {
  skill: InstalledSkill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPublished: () => void;
}

/**
 * 上传本地技能到我们的市场对话框。
 * 字段：slug / displayName / version / changelog（name 固定取自 skill.name）。
 */
export function PublishSkillDialog({
  skill,
  open,
  onOpenChange,
  onPublished,
}: Props) {
  const t = useTranslations("skills");

  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [version, setVersion] = useState("");
  const [changelog, setChangelog] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // 对话框打开时用 skill 信息预填
  useEffect(() => {
    if (open && skill) {
      setSlug(skill.name.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
      setDisplayName(skill.name);
      setVersion(skill.version ?? "1.0.0");
      setChangelog("");
      setError(null);
      setSuccess(false);
    }
  }, [open, skill]);

  // Esc 关闭
  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onOpenChange]);

  if (!open || !skill) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !skill) return;
    setError(null);
    setBusy(true);
    try {
      await publishSkill({
        name: skill.name,
        slug: slug.trim(),
        displayName: displayName.trim(),
        version: version.trim(),
        changelog: changelog.trim() || undefined,
      });
      setSuccess(true);
      setTimeout(() => {
        onPublished();
        onOpenChange(false);
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("publishFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-[420px] flex-col gap-0 border border-border bg-background shadow-lg"
      >
        {/* 对话框头 */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-medium">{t("publishTitle")}</p>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        {/* 表单体 */}
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 p-4 text-sm"
        >
          {/* name（固定，不可改） */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("publishFieldName")}
            </span>
            <input
              readOnly
              value={skill.name}
              className="rounded border border-border bg-muted px-2 py-1 text-muted-foreground"
            />
          </label>

          {/* slug */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("publishFieldSlug")}
            </span>
            <input
              required
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={t("publishFieldSlugPlaceholder")}
              className="rounded border border-border bg-background px-2 py-1"
            />
          </label>

          {/* displayName */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("publishFieldDisplayName")}
            </span>
            <input
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={skill.name}
              className="rounded border border-border bg-background px-2 py-1"
            />
          </label>

          {/* version */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("publishFieldVersion")}
            </span>
            <input
              required
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.0.0"
              className="rounded border border-border bg-background px-2 py-1"
            />
          </label>

          {/* changelog */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("publishFieldChangelog")}
            </span>
            <textarea
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              placeholder={t("publishFieldChangelogPlaceholder")}
              rows={3}
              className="rounded border border-border bg-background px-2 py-1"
            />
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
          {success && (
            <p className="text-xs text-green-600">{t("publishSuccess")}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="rounded px-3 py-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              disabled={busy || success}
              className="flex items-center gap-1.5 rounded bg-foreground px-3 py-1 text-sm text-background hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {success ? t("publishSuccess") : t("publishSubmit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
