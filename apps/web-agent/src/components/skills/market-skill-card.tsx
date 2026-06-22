"use client";

import type {
  MarketSkillSummary,
  SkillInstallSource,
} from "@meshbot/types-agent";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { installSkill } from "@/rest/skills";

interface Props {
  skill: MarketSkillSummary;
  source: SkillInstallSource;
  onInstalled: () => void;
  /** clawhub 暂不支持安装，传 true 禁用安装按钮 */
  disabled?: boolean;
}

/**
 * 市场技能卡片：展示 displayName/description/author/latestVersion/downloads；
 * 「安装」按钮调 installSkill，安装中 loading，成功回调 onInstalled + 内联提示。
 */
export function MarketSkillCard({
  skill,
  source,
  onInstalled,
  disabled,
}: Props) {
  const t = useTranslations("skills");
  const [busy, setBusy] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleInstall() {
    setBusy(true);
    setSuccessMsg(null);
    setErrorMsg(null);
    try {
      await installSkill({
        source,
        ref: skill.slug,
        version: skill.latestVersion,
      });
      setSuccessMsg(t("installSuccess", { name: skill.displayName }));
      onInstalled();
    } catch {
      setErrorMsg(t("installFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{skill.displayName}</p>
          {skill.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {skill.description}
            </p>
          )}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-foreground/60">
            {skill.author && <span>{skill.author}</span>}
            {skill.latestVersion && (
              <>
                <span>·</span>
                <span>v{skill.latestVersion}</span>
              </>
            )}
            {skill.downloads !== undefined && (
              <>
                <span>·</span>
                <span className="flex items-center gap-0.5">
                  <Download className="h-3 w-3" />
                  {skill.downloads.toLocaleString()}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="shrink-0">
          {disabled ? (
            <span
              className="cursor-default rounded px-2 py-1 text-[11px] text-muted-foreground opacity-50"
              title={t("clawhubInstallUnsupported")}
            >
              {t("install")}
            </span>
          ) : (
            <button
              type="button"
              onClick={handleInstall}
              disabled={busy}
              className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              {busy ? t("installing") : t("install")}
            </button>
          )}
        </div>
      </div>

      {/* 内联反馈 */}
      {disabled && (
        <p className="mt-1.5 text-[11px] text-amber-500">
          {t("clawhubInstallUnsupported")}
        </p>
      )}
      {successMsg && (
        <p className="mt-1.5 text-[11px] text-green-600 dark:text-green-400">
          {successMsg}
        </p>
      )}
      {errorMsg && (
        <p className="mt-1.5 text-[11px] text-destructive">{errorMsg}</p>
      )}
    </div>
  );
}
