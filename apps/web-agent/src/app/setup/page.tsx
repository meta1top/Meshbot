"use client";

import type { ModelConfigInput, ProviderDef } from "@anybot/common";
import { getAccessToken } from "@anybot/common";
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
import { registerSchema } from "@anybot/types-agent";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { BrandLayout } from "@/components/brand-layout";
import ModelForm from "@/components/setup/model-form";
import ProviderCard from "@/components/setup/provider-card";
import { useAuthStatus, useRegister } from "@/rest/auth";
import { useCreateModelConfig, useProviders } from "@/rest/model-config";

const setupRegisterSchema = registerSchema
  .extend({
    confirmPassword: z.string().min(1, "请确认密码"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "两次输入的密码不一致",
    path: ["confirmPassword"],
  });

type SetupRegisterValues = z.infer<typeof setupRegisterSchema>;

type SetupStep = "register" | "model";

export default function SetupPage() {
  const router = useRouter();

  const { data: authStatus } = useAuthStatus();
  const { data: providers = [] } = useProviders();
  const registerMutation = useRegister();
  const createModelMutation = useCreateModelConfig();

  const [step, setStep] = useState<SetupStep>(() => {
    if (authStatus?.initialized && getAccessToken()) return "model";
    return "register";
  });
  const [selected, setSelected] = useState<ProviderDef | null>(null);

  const form = useForm<SetupRegisterValues>({
    resolver: zodResolver(setupRegisterSchema),
    defaultValues: { username: "", password: "", confirmPassword: "" },
  });

  if (authStatus?.initialized && getAccessToken() && step === "register") {
    setStep("model");
  }

  const onSubmit = async ({ username, password }: SetupRegisterValues) => {
    try {
      await registerMutation.mutateAsync({ username, password });
      setStep("model");
    } catch (err) {
      form.setError("root", {
        message: err instanceof Error ? err.message : "注册失败，请重试",
      });
    }
  };

  const handleModelSubmit = async (data: ModelConfigInput) => {
    await createModelMutation.mutateAsync(data);
    router.push("/");
  };

  return (
    <BrandLayout className="justify-start pt-16 lg:pt-24">
      <div className="w-full max-w-lg">
        <div className="mb-8 lg:hidden flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-lg font-bold text-primary-foreground">A</span>
          </div>
          <span className="text-2xl font-bold tracking-tight">Anybot</span>
        </div>

        <h1 className="mb-2 text-2xl font-bold text-foreground">
          欢迎使用 Anybot
        </h1>
        <p className="mb-8 text-muted-foreground">
          {step === "register" ? "创建账号以开始使用" : "请配置模型以开始使用"}
        </p>

        {step === "register" && (
          <Card>
            <CardHeader>
              <CardTitle>创建账号</CardTitle>
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
                            autoComplete="new-password"
                            placeholder="至少 6 位"
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
                      <FormItem>
                        <FormLabel>确认密码</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="new-password"
                            placeholder="再次输入密码"
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
                    className="mt-2"
                    disabled={registerMutation.isPending}
                  >
                    {registerMutation.isPending
                      ? "创建中..."
                      : "创建账号并继续"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}

        {step === "model" && (
          <Card>
            <CardHeader>
              <CardTitle>选择供应商</CardTitle>
              <CardDescription>选择一个模型供应商并完成配置</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-6 grid grid-cols-2 gap-2">
                {providers.map((p) => (
                  <ProviderCard
                    key={p.type}
                    name={p.name}
                    description={p.description}
                    selected={selected?.type === p.type}
                    onSelect={() => setSelected(p)}
                  />
                ))}
              </div>

              {selected && (
                <>
                  <div className="mb-4 border-t border-border" />
                  <h3 className="mb-3 text-sm font-semibold text-foreground">
                    模型配置
                  </h3>
                  <ModelForm
                    key={selected.type}
                    provider={selected}
                    onSubmit={handleModelSubmit}
                    submitting={createModelMutation.isPending}
                    error={
                      createModelMutation.error instanceof Error
                        ? createModelMutation.error.message
                        : createModelMutation.error
                          ? "保存失败，请重试"
                          : null
                    }
                  />
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </BrandLayout>
  );
}
