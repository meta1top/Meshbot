"use client";

import type { CreateCronJobInput, SessionSummary } from "@meshbot/types-agent";
import cronstrue from "cronstrue/i18n";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

interface Props {
  sessions: SessionSummary[];
  defaultSessionId?: string;
  onSubmit: (input: CreateCronJobInput) => Promise<void>;
  onCancel: () => void;
}

const browserTz =
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";

export function CronJobForm({
  sessions,
  defaultSessionId,
  onSubmit,
  onCancel,
}: Props) {
  const t = useTranslations("schedule");
  const [sessionId, setSessionId] = useState(
    defaultSessionId ?? sessions[0]?.id ?? "",
  );
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"cron" | "once">("cron");
  const [cronExpr, setCronExpr] = useState("0 7 * * *");
  const [timezone, setTimezone] = useState(browserTz);
  const [runAt, setRunAt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cronPreview = useMemo(() => {
    if (kind !== "cron" || !cronExpr) return null;
    try {
      return cronstrue.toString(cronExpr, {
        locale: "zh_CN",
        throwExceptionOnParseError: true,
      });
    } catch {
      return null;
    }
  }, [kind, cronExpr]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (kind === "cron" && !cronPreview) {
      setError(t("validation.cronInvalid"));
      return;
    }
    if (kind === "once" && !runAt) {
      setError(t("validation.runAtRequired"));
      return;
    }
    if (kind === "once" && new Date(runAt).getTime() <= Date.now()) {
      setError(t("validation.runAtPast"));
      return;
    }
    setBusy(true);
    try {
      const input: CreateCronJobInput = {
        sessionId,
        title,
        prompt,
        kind,
        cronExpr: kind === "cron" ? cronExpr : undefined,
        timezone: kind === "cron" ? timezone : undefined,
        runAt: kind === "once" ? new Date(runAt).toISOString() : undefined,
      };
      await onSubmit(input);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3 text-sm"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("jobTitle")}</span>
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("jobTitlePlaceholder")}
          className="rounded border border-border bg-background px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("session")}</span>
        <select
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1"
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={kind === "cron"}
            onChange={() => {
              setKind("cron");
              setError(null);
            }}
          />
          {t("kindCron")}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={kind === "once"}
            onChange={() => {
              setKind("once");
              setError(null);
            }}
          />
          {t("kindOnce")}
        </label>
      </div>

      {kind === "cron" ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("cronExpr")}
            </span>
            <input
              required
              value={cronExpr}
              onChange={(e) => {
                setCronExpr(e.target.value);
                setError(null);
              }}
              placeholder={t("cronPlaceholder")}
              className="rounded border border-border bg-background px-2 py-1 font-mono"
            />
          </label>
          {cronPreview && (
            <p className="text-xs text-muted-foreground">{cronPreview}</p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("timezone")}
            </span>
            <input
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1"
            />
          </label>
        </div>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t("runAt")}</span>
          <input
            type="datetime-local"
            required
            value={runAt}
            onChange={(e) => {
              setRunAt(e.target.value);
              setError(null);
            }}
            className="rounded border border-border bg-background px-2 py-1"
          />
        </label>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("prompt")}</span>
        <textarea
          required
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("promptPlaceholder")}
          rows={3}
          className="rounded border border-border bg-background px-2 py-1"
        />
      </label>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
        >
          {t("cancel")}
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-foreground px-3 py-1 text-sm text-background hover:opacity-90 disabled:opacity-50"
        >
          {t("save")}
        </button>
      </div>
    </form>
  );
}
