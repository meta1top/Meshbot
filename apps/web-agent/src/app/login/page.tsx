"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
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
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { BrandLayout } from "@/components/brand-layout";
import { useLogin } from "@/rest/auth";

export default function LoginPage() {
  const router = useRouter();
  const loginMutation = useLogin();

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
    <BrandLayout>
      <div className="w-full max-w-sm">
        <div className="mb-8 lg:hidden flex items-center gap-3 justify-center">
          <div className="h-10 w-10 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-lg font-bold text-primary-foreground">A</span>
          </div>
          <span className="text-2xl font-bold tracking-tight">Anybot</span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-center text-2xl">登录</CardTitle>
          </CardHeader>
          <CardContent>
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
                      <FormLabel>用户名</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          autoComplete="username"
                          placeholder="请输入用户名"
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
                      <FormLabel>密码</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="current-password"
                          placeholder="请输入密码"
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
                        : "登录失败，请重试"}
                    </AlertDescription>
                  </Alert>
                )}

                <Button
                  type="submit"
                  className="mt-2 w-full"
                  disabled={loginMutation.isPending}
                >
                  {loginMutation.isPending ? "登录中..." : "登录"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </BrandLayout>
  );
}
