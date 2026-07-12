"use client";

import { Alert, AlertDescription, Button, Input } from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import {
  type AuthorizeCodeInput,
  authorizeCodeSchema,
} from "@meshbot/types-agent";
import { BrandLogo } from "@meshbot/web-common/shell";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { AuthShellLayout } from "@/components/layouts/auth-shell-layout";
import { profileQueryKey } from "@/lib/profile-client";
import { ACCENT_BTN } from "@/lib/ui";
import {
  applyAuthToken,
  completeAuthorize,
  pollAuthorize,
  startAuthorize,
  useCloudWebUrl,
} from "@/rest/auth";

const POLL_INTERVAL_MS = 2000;
const WAIT_TIMEOUT_MS = 30 * 60 * 1000;

type Stage = "idle" | "waiting" | "timeout";

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const t = useTranslations("login");
  const cloudWebUrl = useCloudWebUrl();
  const manualSchema = useSchema(authorizeCodeSchema);

  const [stage, setStage] = useState<Stage>("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const requestIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
  };

  // 卸载时清理定时器，避免泄漏（不依赖外部 clearTimers 闭包，直接清引用）
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    };
  }, []);

  const finishLogin = async (access_token: string) => {
    clearTimers();
    applyAuthToken(access_token);
    queryClient.invalidateQueries({ queryKey: profileQueryKey });
    router.replace("/");
  };

  const beginPolling = (requestId: string) => {
    clearTimers();
    requestIdRef.current = requestId;
    setStage("waiting");
    pollTimerRef.current = setInterval(async () => {
      if (requestIdRef.current !== requestId) return;
      try {
        const r = await pollAuthorize(requestId);
        if (r.status === "done") {
          void finishLogin(r.access_token);
        }
      } catch {
        // 单次轮询失败不打断等待态，下一轮再试
      }
    }, POLL_INTERVAL_MS);
    timeoutTimerRef.current = setTimeout(() => {
      if (requestIdRef.current !== requestId) return;
      clearTimers();
      requestIdRef.current = null;
      setStage("timeout");
    }, WAIT_TIMEOUT_MS);
  };

  const onBrowserLogin = async () => {
    setStartError(null);
    setStarting(true);
    try {
      const { requestId, authorizeUrl } = await startAuthorize();
      window.open(authorizeUrl, "_blank");
      beginPolling(requestId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : t("startFailed"));
    } finally {
      setStarting(false);
    }
  };

  const onCancelWaiting = () => {
    clearTimers();
    requestIdRef.current = null;
    setStage("idle");
  };

  const onManualSubmit = async (values: AuthorizeCodeInput) => {
    setManualError(null);
    setManualSubmitting(true);
    try {
      const { access_token } = await completeAuthorize(values.code);
      await finishLogin(access_token);
    } catch (err) {
      setManualError(err instanceof Error ? err.message : t("manualFailed"));
    } finally {
      setManualSubmitting(false);
    }
  };

  const registerHref = cloudWebUrl.data
    ? `${cloudWebUrl.data.webMainBase}/register`
    : undefined;

  return (
    <AuthShellLayout>
      <BrandLogo size="md" withWordmark />

      {stage === "waiting" ? (
        <>
          <h1 className="text-[22px] font-extrabold tracking-tight">
            {t("waitingHeadline")}
          </h1>
          <p className="-mt-2 text-[12.5px] text-(--shell-sidebar-fg)/60">
            {t("waitingSub")}
          </p>
          <div className="flex items-center gap-2 text-[12px] text-(--shell-sidebar-fg)/70">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-(--shell-accent)" />
            {t("waitingText")}
          </div>
          <button
            type="button"
            onClick={onBrowserLogin}
            disabled={starting}
            className="text-[11px] text-(--shell-sidebar-fg)/55 hover:text-(--shell-accent)"
          >
            {t("reopen")}
          </button>
          <button
            type="button"
            onClick={onCancelWaiting}
            className="text-[11px] text-(--shell-sidebar-fg)/45 hover:text-(--shell-sidebar-fg)"
          >
            {t("cancel")}
          </button>
        </>
      ) : (
        <>
          <h1 className="text-[22px] font-extrabold tracking-tight">
            {t("deviceHeadline")}
          </h1>
          <p className="-mt-2 text-[12.5px] text-(--shell-sidebar-fg)/60">
            {t("deviceSubtitle")}
          </p>
          {stage === "timeout" && (
            <Alert variant="destructive" className="text-left">
              <AlertDescription>{t("timeoutMessage")}</AlertDescription>
            </Alert>
          )}
          {startError && (
            <Alert variant="destructive" className="text-left">
              <AlertDescription>{startError}</AlertDescription>
            </Alert>
          )}
          <Button
            type="button"
            className={`h-12 w-full max-w-[300px] rounded-[14px] text-[13px] ${ACCENT_BTN}`}
            disabled={starting}
            onClick={onBrowserLogin}
          >
            {starting ? t("starting") : t("browserLoginButton")}
          </Button>
          <p className="text-[10.5px] leading-relaxed text-(--shell-sidebar-fg)/45">
            {t("footNote")}
          </p>
        </>
      )}

      {/* 手动输码：折叠兜底（loopback 失败 / 无回环场景） */}
      <div className="w-full max-w-[300px]">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1 text-[11px] text-(--shell-sidebar-fg)/45 hover:text-(--shell-sidebar-fg)"
          onClick={() => setManualOpen((v) => !v)}
          aria-expanded={manualOpen}
        >
          {t("manualToggle")}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${manualOpen ? "rotate-180" : ""}`}
          />
        </button>
        {manualOpen && (
          <Form
            schema={manualSchema}
            defaultValues={{ code: "" }}
            onSubmit={onManualSubmit}
            disabled={manualSubmitting}
            className="mt-3 flex flex-col gap-3 text-left"
          >
            <FormItem name="code" label={t("manualLabel")}>
              <Input
                autoComplete="one-time-code"
                placeholder={t("manualPlaceholder")}
              />
            </FormItem>
            {manualError && (
              <Alert variant="destructive">
                <AlertDescription>{manualError}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" variant="outline" disabled={manualSubmitting}>
              {manualSubmitting ? t("manualSubmitting") : t("manualSubmit")}
            </Button>
          </Form>
        )}
      </div>

      {registerHref ? (
        <p className="text-[11px] text-(--shell-sidebar-fg)/45">
          {t("noAccount")}{" "}
          <a
            href={registerHref}
            target="_blank"
            rel="noreferrer"
            className="text-(--shell-accent) hover:underline"
          >
            {t("goRegister")}
          </a>
        </p>
      ) : null}
    </AuthShellLayout>
  );
}
