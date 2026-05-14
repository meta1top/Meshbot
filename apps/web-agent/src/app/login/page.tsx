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
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthShellLayout } from "@/components/layouts/auth-shell-layout";
import { useLogin } from "@/rest/auth";

export default function LoginPage() {
  const router = useRouter();
  const loginMutation = useLogin();
  const t = useTranslations("login");
  const schema = useSchema(loginSchema);

  const onSubmit = async (values: LoginInput) => {
    try {
      await loginMutation.mutateAsync(values);
      router.push("/");
    } catch {
      // error is available via loginMutation.error
    }
  };

  return (
    <AuthShellLayout>
      <div className="w-full max-w-[430px] border border-border bg-card shadow-sm">
        <Card className="border-0 shadow-none">
          <CardHeader className="space-y-0 pb-4">
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
              defaultValues={{ username: "", password: "" }}
              onSubmit={onSubmit}
              className="flex flex-col gap-4"
            >
              <FormItem
                name="username"
                label={
                  <span className="text-[11px] tracking-[0.08em] uppercase">
                    {t("account")}
                  </span>
                }
              >
                <Input
                  type="text"
                  autoComplete="username"
                  placeholder={t("accountPlaceholder")}
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
                    {loginMutation.error instanceof Error
                      ? loginMutation.error.message
                      : t("loginFailed")}
                  </AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                className="mt-2 w-full bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? t("signingIn") : t("signIn")}
              </Button>
            </Form>
          </CardContent>
        </Card>
      </div>
    </AuthShellLayout>
  );
}
