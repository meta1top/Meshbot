"use client";

import { cn } from "@meshbot/design";
import type { CronJobDto } from "@meshbot/types-agent";
import cronstrue from "cronstrue/i18n";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

interface Props {
  job: CronJobDto;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
  busy?: boolean;
}

export function CronJobCard({ job, onToggle, onDelete, busy }: Props) {
  const t = useTranslations("schedule");
  const scheduleLine =
    job.kind === "cron"
      ? `${job.cronExpr} · ${cronstrue.toString(job.cronExpr as string, {
          locale: "zh_CN",
          throwExceptionOnParseError: false,
        })}${job.timezone ? ` (${job.timezone})` : ""}`
      : new Date(job.runAt as string).toLocaleString();
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-card p-3">
      <div className="min-w-0 flex-1">
        <Link
          href={`/messages?kind=assistant&id=${job.sessionId}`}
          className="block truncate text-sm font-medium hover:underline"
        >
          {job.title}
        </Link>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {job.prompt}
        </p>
        <p className="mt-1 text-[11px] text-foreground/60">{scheduleLine}</p>
        {job.nextFireAt && (
          <p className="mt-0.5 text-[11px] text-foreground/50">
            {t("nextFire", { when: new Date(job.nextFireAt).toLocaleString() })}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onToggle(!job.enabled)}
          disabled={busy}
          className={cn(
            "rounded px-2 py-1 text-[11px]",
            job.enabled
              ? "bg-foreground/8 text-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {job.enabled ? t("enabled") : t("disabled")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          title={t("delete")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
