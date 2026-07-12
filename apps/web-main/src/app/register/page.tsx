"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Alert,
  AlertDescription,
  Button,
  CardDescription,
  CardTitle,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from "@meshbot/design";
import { useSchema } from "@meshbot/design/hooks";
import {
  type RegisterUserInput,
  RegisterUserSchema,
} from "@meshbot/types-main";
import { AuthCard } from "@meshbot/web-common/shell";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AuthChainBanner } from "@/components/auth/auth-chain-banner";
import { AuthShell } from "@/components/auth/auth-shell";
import { ApiError } from "@/lib/api";
import { useRegister, useResendCode, useVerifyEmail } from "@/rest/auth";

type RegisterFormValues = RegisterUserInput & { confirmPassword: string };

type Step = "register" | "verify";

/** 重发验证码倒计时秒数，与后端 `resend-code` 节流窗口一致（前端自持，不依赖冷却错误码）。 */
const RESEND_COOLDOWN_SECONDS = 60;

function RegisterFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  const t = useTranslations("register");

  const registerMutation = useRegister();
  const verifyMutation = useVerifyEmail();
  const resendMutation = useResendCode();

  // URL `?step=verify&email=` 直达 step2 —— 登录页 2022（邮箱未验证）分流入口。
  const [step, setStep] = useState<Step>(
    searchParams.get("step") === "verify" ? "verify" : "register",
  );
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const translatedSchema = useSchema(RegisterUserSchema);
  const registerSchema = translatedSchema
    .extend({
      confirmPassword: z
        .string()
        .min(1, t("validation.confirmPasswordRequired")),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: t("validation.passwordNotMatch"),
      path: ["confirmPassword"],
    });

  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      email,
      displayName: "",
      password: "",
      confirmPassword: "",
    },
  });

  const onSubmitRegister = async (values: RegisterFormValues) => {
    try {
      await registerMutation.mutateAsync({
        email: values.email,
        displayName: values.displayName,
        password: values.password,
      });
      setEmail(values.email);
      setStep("verify");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      form.setError("root", {
        message: err instanceof ApiError ? err.message : t("registerFailed"),
      });
    }
  };

  const onSubmitVerify = async (evt: React.FormEvent) => {
    evt.preventDefault();
    setVerifyError(null);
    try {
      await verifyMutation.mutateAsync({ email, code });
    } catch (err) {
      setVerifyError(err instanceof ApiError ? err.message : t("verifyFailed"));
      return;
    }
    router.replace(next ?? "/assistant");
  };

  const onResend = async () => {
    if (cooldown > 0 || resendMutation.isPending) return;
    // 未知邮箱后端也静默返回 ok（防枚举），前端一律启动倒计时，不据此判断邮箱是否存在。
    setCooldown(RESEND_COOLDOWN_SECONDS);
    try {
      await resendMutation.mutateAsync({ email });
    } catch {
      // 重发失败不阻塞用户 —— 倒计时已启动，到期后可再次点击重试
    }
  };

  return (
    <AuthShell>
      <div className="w-full">
        <AuthCard>
          <AuthChainBanner />
          {step === "register" && (
            <div>
              <div className="space-y-1 pb-3">
                <CardTitle className="text-center">
                  {t("createAccount")}
                </CardTitle>
                <CardDescription className="text-center">
                  {t("createAccountDescription")}
                </CardDescription>
              </div>
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmitRegister)}
                  className="flex flex-col gap-5"
                >
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem className="space-y-4">
                        <FormLabel>{t("email")}</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            autoComplete="email"
                            placeholder={t("emailPlaceholder")}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="displayName"
                    render={({ field }) => (
                      <FormItem className="space-y-4">
                        <FormLabel>{t("displayName")}</FormLabel>
                        <FormControl>
                          <Input
                            autoComplete="nickname"
                            placeholder={t("displayNamePlaceholder")}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem className="space-y-4">
                        <FormLabel>{t("password")}</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="new-password"
                            placeholder={t("passwordPlaceholder")}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="confirmPassword"
                    render={({ field }) => (
                      <FormItem className="space-y-4">
                        <FormLabel>{t("confirmPassword")}</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="new-password"
                            placeholder={t("confirmPasswordPlaceholder")}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {form.formState.errors.root && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {form.formState.errors.root.message}
                      </AlertDescription>
                    </Alert>
                  )}

                  <Button
                    type="submit"
                    className="mt-1 h-11 w-full rounded-xl bg-(--shell-accent) text-white hover:bg-(--shell-accent-hover)"
                    disabled={registerMutation.isPending}
                  >
                    {registerMutation.isPending
                      ? t("creating")
                      : t("createAndContinue")}
                  </Button>

                  <p className="mt-1 text-center text-xs text-muted-foreground">
                    {t("haveAccount")}{" "}
                    <Link
                      href="/login"
                      className="text-(--shell-accent) hover:underline"
                    >
                      {t("goLogin")}
                    </Link>
                  </p>
                </form>
              </Form>
            </div>
          )}

          {step === "verify" && (
            <div>
              <div className="space-y-1 pb-3">
                <CardTitle className="text-center">
                  {t("verifyTitle")}
                </CardTitle>
                <CardDescription className="text-center">
                  {t("verifyDescription", { email })}
                </CardDescription>
              </div>
              <form onSubmit={onSubmitVerify} className="flex flex-col gap-5">
                <div className="space-y-4">
                  <label
                    htmlFor="verify-code"
                    className="text-sm leading-none font-medium"
                  >
                    {t("code")}
                  </label>
                  <Input
                    id="verify-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder={t("codePlaceholder")}
                    value={code}
                    onChange={(evt) =>
                      setCode(evt.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                  />
                </div>

                {verifyError && (
                  <Alert variant="destructive">
                    <AlertDescription>{verifyError}</AlertDescription>
                  </Alert>
                )}

                <Button
                  type="submit"
                  className="mt-1 h-11 w-full rounded-xl bg-(--shell-accent) text-white hover:bg-(--shell-accent-hover)"
                  disabled={verifyMutation.isPending || code.length !== 6}
                >
                  {verifyMutation.isPending
                    ? t("verifying")
                    : t("verifyAndContinue")}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  disabled={cooldown > 0 || resendMutation.isPending}
                  onClick={onResend}
                >
                  {cooldown > 0
                    ? t("resendIn", { seconds: cooldown })
                    : t("resend")}
                </Button>
              </form>
            </div>
          )}
        </AuthCard>
      </div>
    </AuthShell>
  );
}

/** `useSearchParams` 需要 Suspense 边界包裹，否则 Next.js 静态渲染报错。 */
export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterFlow />
    </Suspense>
  );
}
