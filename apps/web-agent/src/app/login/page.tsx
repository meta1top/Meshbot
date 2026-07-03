"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import {
  type AuthorizeCodeInput,
  authorizeCodeSchema,
} from "@meshbot/types-agent";
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
  authStatusQueryKey,
  completeAuthorize,
  pollAuthorize,
  startAuthorize,
  useCloudWebUrl,
} from "@/rest/auth";

const POLL_INTERVAL_MS = 2000;
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;

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
    queryClient.invalidateQueries({ queryKey: authStatusQueryKey });
    router.replace("/");
  };

  const beginPolling = (requestId: string) => {
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
      <div className="w-full max-w-[380px]">
        <Card className="border-0 shadow-none">
          <CardHeader className="space-y-0 pb-4">
            <p className="mb-1 text-xs text-muted-foreground">
              {t("welcomeBack")}
            </p>
            <CardTitle className="text-left text-[28px] leading-[1.15] font-semibold tracking-tight text-foreground">
              {t("title")}
            </CardTitle>
            <CardDescription className="mt-1 text-left text-[12px] tracking-[0.08em] text-muted-foreground">
              {t("subtitle")}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex flex-col gap-4">
              {stage === "waiting" ? (
                <div className="flex flex-col items-center gap-3 rounded-md border border-border py-8 text-center">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <p className="text-sm text-foreground">{t("waitingText")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("waitingHint")}
                  </p>
                  <Button variant="outline" size="sm" onClick={onCancelWaiting}>
                    {t("cancel")}
                  </Button>
                </div>
              ) : (
                <>
                  {stage === "timeout" && (
                    <Alert variant="destructive">
                      <AlertDescription>{t("timeoutMessage")}</AlertDescription>
                    </Alert>
                  )}
                  {startError && (
                    <Alert variant="destructive">
                      <AlertDescription>{startError}</AlertDescription>
                    </Alert>
                  )}
                  <Button
                    type="button"
                    className={`w-full ${ACCENT_BTN}`}
                    disabled={starting}
                    onClick={onBrowserLogin}
                  >
                    {starting ? t("starting") : t("browserLoginButton")}
                  </Button>
                </>
              )}

              <div className="mt-1">
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
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
                    className="mt-3 flex flex-col gap-3"
                  >
                    <FormItem
                      name="code"
                      label={
                        <span className="text-[11px] tracking-[0.08em] uppercase">
                          {t("manualLabel")}
                        </span>
                      }
                    >
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
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={manualSubmitting}
                    >
                      {manualSubmitting
                        ? t("manualSubmitting")
                        : t("manualSubmit")}
                    </Button>
                  </Form>
                )}
              </div>

              <p className="mt-3 text-center text-xs text-muted-foreground">
                {t("noAccount")}{" "}
                {registerHref ? (
                  <a
                    href={registerHref}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    {t("goRegister")}
                  </a>
                ) : (
                  <span className="text-muted-foreground">
                    {t("goRegister")}
                  </span>
                )}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </AuthShellLayout>
  );
}
