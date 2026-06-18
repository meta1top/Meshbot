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
import { type LoginInput, loginSchema } from "@meshbot/types-agent";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthShellLayout } from "@/components/layouts/auth-shell-layout";
import { fetchAuthStatus, useLogin } from "@/rest/auth";

export default function LoginPage() {
  const router = useRouter();
  const loginMutation = useLogin();
  const t = useTranslations("login");
  const schema = useSchema(loginSchema);

  const onSubmit = async (values: LoginInput) => {
    try {
      await loginMutation.mutateAsync(values);
    } catch {
      // 登录失败：错误经 loginMutation.error 展示
      return;
    }
    // 登录成功后按「本账号」setup 状态分流：未配置 org / 模型 → 进向导补齐，
    // 否则进主页。fetchAuthStatus 走 apiClient，已带上刚登录账号的活跃 token。
    try {
      const status = await fetchAuthStatus();
      // needs-org 必须走 /setup 补完组织创建流程；
      // needs-model / ready 均进 /assistant，由 AuthGuard 布局层决定是否显示模型配置引导。
      router.replace(status.step === "needs-org" ? "/setup" : "/assistant");
    } catch {
      router.replace("/assistant");
    }
  };

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

              {loginMutation.error && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {loginMutation.error instanceof Error &&
                    loginMutation.error.message
                      ? loginMutation.error.message
                      : t("loginFailed")}
                  </AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                className="mt-2 w-full bg-(--shell-accent) text-white hover:opacity-90"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? t("signingIn") : t("signIn")}
              </Button>

              <p className="mt-3 text-center text-xs text-muted-foreground">
                {t("noAccount")}{" "}
                <Link href="/setup" className="text-primary hover:underline">
                  {t("goRegister")}
                </Link>
              </p>
            </Form>
          </CardContent>
        </Card>
      </div>
    </AuthShellLayout>
  );
}
