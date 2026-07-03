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
import { type LoginInput, LoginSchema } from "@meshbot/types-main";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useState } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { ApiError } from "@/lib/api";
import { useLogin } from "@/rest/auth";

/** 后端 `AUTH_EMAIL_NOT_VERIFIED` 错误码——登录时邮箱未验证，分流去注册页续验证。 */
const AUTH_EMAIL_NOT_VERIFIED_CODE = 2022;

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  const loginMutation = useLogin();
  const t = useTranslations("login");
  const schema = useSchema(LoginSchema);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onSubmit = async (values: LoginInput) => {
    setErrorMessage(null);
    try {
      await loginMutation.mutateAsync(values);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === AUTH_EMAIL_NOT_VERIFIED_CODE
      ) {
        // 2022 分流去注册页续验证时透传 next —— 设备授权链（/authorize）靠它回跳。
        const nextSuffix = next ? `&next=${encodeURIComponent(next)}` : "";
        router.push(
          `/register?step=verify&email=${encodeURIComponent(values.email)}${nextSuffix}`,
        );
        return;
      }
      setErrorMessage(err instanceof ApiError ? err.message : t("loginFailed"));
      return;
    }
    router.replace(next ?? "/settings/org");
  };

  return (
    <AuthShell>
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
            <Form
              schema={schema}
              defaultValues={{ email: "", password: "" }}
              onSubmit={onSubmit}
              className="flex flex-col gap-4"
            >
              <FormItem
                name="email"
                label={
                  <span className="text-[11px] tracking-[0.08em] uppercase">
                    {t("email")}
                  </span>
                }
              >
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder={t("emailPlaceholder")}
                />
              </FormItem>

              <FormItem
                name="password"
                label={
                  <span className="text-[11px] tracking-[0.08em] uppercase">
                    {t("password")}
                  </span>
                }
              >
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="********"
                />
              </FormItem>

              {errorMessage && (
                <Alert variant="destructive">
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                className="mt-2 w-full"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? t("signingIn") : t("signIn")}
              </Button>

              <p className="mt-3 text-center text-xs text-muted-foreground">
                {t("noAccount")}{" "}
                <Link href="/register" className="text-primary hover:underline">
                  {t("goRegister")}
                </Link>
              </p>
            </Form>
          </CardContent>
        </Card>
      </div>
    </AuthShell>
  );
}

/** `useSearchParams` 需要 Suspense 边界包裹，否则 Next.js 静态渲染报错。 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
