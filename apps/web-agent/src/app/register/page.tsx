"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from "@meshbot/design";
import { useSchema } from "@meshbot/design/hooks";
import { registerSchema } from "@meshbot/types-agent";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AuthShellLayout } from "@/components/layouts/auth-shell-layout";

import { OrgStep } from "@/components/setup/org-step";
import { ACCENT_BTN } from "@/lib/ui";
import { useAuthStatus, useRegister } from "@/rest/auth";

type SetupRegisterValues = {
  email: string;
  displayName: string;
  password: string;
  confirmPassword: string;
};

type WizardStep = "register" | "org";

/** 向导步骤顺序 —— setup-status 只能「向前」推进，不能把用户已推进的步骤往回拽。 */
const STEP_ORDER: Record<WizardStep, number> = {
  register: 0,
  org: 1,
};

export default function SetupPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const t = useTranslations("setup");

  const { data: authStatus } = useAuthStatus();
  const registerMutation = useRegister();

  const [step, setStep] = useState<WizardStep>("register");
  const translatedRegisterSchema = useSchema(registerSchema);
  const setupRegisterSchema = translatedRegisterSchema
    .extend({
      confirmPassword: z
        .string()
        .min(1, t("validation.confirmPasswordRequired")),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: t("validation.passwordNotMatch"),
      path: ["confirmPassword"],
    });

  const form = useForm<SetupRegisterValues>({
    resolver: zodResolver(setupRegisterSchema),
    defaultValues: {
      email: "",
      displayName: "",
      password: "",
      confirmPassword: "",
    },
  });

  useEffect(() => {
    if (!authStatus) return;
    // 模型配置已移出向导：服务端判定 needs-model 时，交给登录后 shell 的模型引导处理
    if (authStatus.step === "needs-model") {
      router.replace("/assistant");
      return;
    }
    // 注册成功 → 服务端转 needs-org，向导只向前推进到 org，绝不回拽用户已推进的步骤
    if (authStatus.step === "needs-org") {
      setStep((cur) => (STEP_ORDER.org > STEP_ORDER[cur] ? "org" : cur));
    }
  }, [authStatus, router]);

  const onSubmit = async ({
    email,
    displayName,
    password,
  }: SetupRegisterValues) => {
    try {
      await registerMutation.mutateAsync({ email, displayName, password });
      setStep("org");
    } catch (err) {
      form.setError("root", {
        message: err instanceof Error ? err.message : t("registerFailed"),
      });
    }
  };

  return (
    <AuthShellLayout>
      <div className={cn("w-full max-w-[420px]")}>
        <div className="pr-1">
          <span className="mb-4 inline-flex items-center rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
            {t("getStarted")}
          </span>
          {step === "register" && (
            <Card className="border-0 shadow-none">
              <CardHeader className="space-y-1">
                <CardTitle>{t("createAccount")}</CardTitle>
                <CardDescription>
                  {t("createAccountDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-3">
                <Form {...form}>
                  <form
                    onSubmit={form.handleSubmit(onSubmit)}
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
                      className={`mt-1 ${ACCENT_BTN}`}
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
                        className="text-primary hover:underline"
                      >
                        {t("goLogin")}
                      </Link>
                    </p>
                  </form>
                </Form>
              </CardContent>
            </Card>
          )}

          {step === "org" && (
            <OrgStep
              onDone={() => {
                queryClient.invalidateQueries({ queryKey: ["auth", "status"] });
                router.push("/assistant");
              }}
            />
          )}
        </div>
      </div>
    </AuthShellLayout>
  );
}
