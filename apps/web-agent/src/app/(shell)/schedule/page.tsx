"use client";

import type { CronJobDto } from "@meshbot/types-agent";
import { useAtomValue } from "jotai";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { sessionsAtom } from "@/atoms/sessions";
import { ToolPage } from "@/components/layouts/tool-page";
import { CronJobCard } from "@/components/schedule/cron-job-card";
import { CronJobForm } from "@/components/schedule/cron-job-form";
import {
  createCronJob,
  deleteCronJob,
  listCronJobs,
  patchCronJob,
} from "@/rest/cron-jobs";

export default function SchedulePage() {
  const t = useTranslations("schedule");
  const sessions = useAtomValue(sessionsAtom);
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
    <ToolPage
      title={t("title")}
      actions={
        <button
          type="button"
          onClick={() => setFormOpen((v) => !v)}
          className="rounded-md bg-foreground/8 px-3 py-1.5 text-sm font-medium hover:bg-foreground/12"
        >
          {formOpen ? t("cancel") : t("newJob")}
        </button>
      }
    >
      {formOpen && (
        <div className="mb-4">
          <CronJobForm
            sessions={sessions}
            onCancel={() => setFormOpen(false)}
            onSubmit={async (input) => {
              await createCronJob(input);
              setFormOpen(false);
              await reload();
            }}
          />
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
    </ToolPage>
  );
}
