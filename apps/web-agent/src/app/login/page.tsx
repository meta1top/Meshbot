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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from "@anybot/design";
import { type LoginInput, loginSchema } from "@anybot/types-agent";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { AuthShellLayout } from "@/components/layouts/auth-shell-layout";
import { useLogin } from "@/rest/auth";

export default function LoginPage() {
  const router = useRouter();
  const loginMutation = useLogin();
  const t = useTranslations("login");

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

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
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="flex flex-col gap-4"
              >
                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[11px] tracking-[0.08em] uppercase">
                        {t("account")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          autoComplete="username"
                          placeholder={t("accountPlaceholder")}
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
                    <FormItem>
                      <FormLabel className="text-[11px] tracking-[0.08em] uppercase">
                        {t("password")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="current-password"
                          placeholder="********"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

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
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </AuthShellLayout>
  );
}
