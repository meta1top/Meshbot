"use client";

import { cn } from "@meshbot/design";
import type { InstalledSkill } from "@meshbot/types-agent";
import { Trash2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { uninstallSkill } from "@/rest/skills";

interface Props {
  skill: InstalledSkill;
  /** 当前选中 Agent id（Task 12：卸载按此隔离，落到对应 Agent 的 skills 目录）。 */
  agentId?: string;
  onUninstalled: () => void;
  onPublish: (skill: InstalledSkill) => void;
}

/**
 * 已安装技能卡片：展示 name/description/source/version；
 * 操作「卸载」（内联确认后执行）和「上传到市场」（触发父级 dialog）。
 */
export function InstalledSkillCard({
  skill,
  agentId,
  onUninstalled,
  onPublish,
}: Props) {
  const t = useTranslations("skills");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleConfirmUninstall() {
    setBusy(true);
    try {
      await uninstallSkill(skill.name, agentId);
      onUninstalled();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const sourceLabel: Record<string, string> = {
    system: t("sourceOurMarket"),
    github: "GitHub",
    clawhub: t("sourceClawhub"),
  };

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{skill.name}</p>
          {skill.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {skill.description}
            </p>
          )}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-foreground/60">
            {skill.source && (
              <span>{sourceLabel[skill.source] ?? skill.source}</span>
            )}
            {skill.version && (
              <>
                <span>·</span>
                <span>v{skill.version}</span>
              </>
            )}
            {skill.installedAt && (
              <>
                <span>·</span>
                <span>{new Date(skill.installedAt).toLocaleDateString()}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* 上传到市场 */}
          <button
            type="button"
            onClick={() => onPublish(skill)}
            disabled={busy}
            title={t("publish")}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-primary/10 hover:text-primary disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>{t("publish")}</span>
          </button>

          {/* 卸载按钮 */}
          {confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded p-1 text-muted-foreground hover:bg-muted"
              title={t("cancel")}
            >
              ✕
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy}
              title={t("uninstall")}
              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 内联确认区 */}
      {confirming && (
        <div className="mt-2 flex items-center justify-between rounded-md bg-destructive/8 px-3 py-2 text-xs">
          <span className="text-foreground/80">
            {t("uninstallConfirmDesc", { name: skill.name })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={cn(
                "rounded px-2 py-0.5 text-muted-foreground hover:text-foreground",
              )}
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleConfirmUninstall}
              disabled={busy}
              className="rounded bg-destructive px-2 py-0.5 text-destructive-foreground disabled:opacity-50"
            >
              {busy ? t("uninstalling") : t("uninstallConfirm")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
