"use client";

import type { CronJobDto } from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { CronJobCard } from "@/components/schedule/cron-job-card";
import { deleteCronJob, listCronJobs, patchCronJob } from "@/rest/cron-jobs";

export default function SchedulePage() {
  const t = useTranslations("schedule");
  const [jobs, setJobs] = useState<CronJobDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { jobs } = await listCronJobs();
      setJobs(jobs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleToggle = useCallback(
    async (id: string, next: boolean) => {
      setBusyId(id);
      try {
        await patchCronJob(id, { enabled: next });
        await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const handleDelete = useCallback(
    async (id: string, title: string) => {
      if (!confirm(t("deleteConfirm", { title }))) return;
      setBusyId(id);
      try {
        await deleteCronJob(id);
        await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload, t],
  );

  return (
    <AppShellLayout>
      <div className="mx-auto w-full max-w-2xl p-4">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-medium">{t("title")}</h1>
          <button
            type="button"
            onClick={() => setFormOpen((v) => !v)}
            className="rounded-md bg-foreground/8 px-3 py-1.5 text-sm font-medium hover:bg-foreground/12"
          >
            {formOpen ? t("cancel") : t("newJob")}
          </button>
        </div>

        {formOpen && (
          <div className="mb-4 rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
            {/* Task 14 接入完整 CronJobForm */}
            (form placeholder)
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.map((j) => (
              <CronJobCard
                key={j.id}
                job={j}
                busy={busyId === j.id}
                onToggle={(next) => handleToggle(j.id, next)}
                onDelete={() => handleDelete(j.id, j.title)}
              />
            ))}
          </div>
        )}
      </div>
    </AppShellLayout>
  );
}
