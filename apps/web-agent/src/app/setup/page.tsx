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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@meshbot/design";
import { useSchema } from "@meshbot/design/hooks";
import { registerSchema } from "@meshbot/types-agent";
import type { ModelConfigInput, ProviderDef } from "@meshbot/web-common";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  siAnthropic,
  siDeepseek,
  siGooglegemini,
  siOllama,
  siOpenaigym,
  siOpenrouter,
} from "simple-icons";
import { z } from "zod";
import { AuthShellLayout } from "@/components/layouts/auth-shell-layout";
import ModelForm from "@/components/setup/model-form";
import { OrgStep } from "@/components/setup/org-step";
import { useAuthStatus, useRegister } from "@/rest/auth";
import { useCreateModelConfig, useProviders } from "@/rest/model-config";

type SetupRegisterValues = {
  email: string;
  displayName: string;
  password: string;
  confirmPassword: string;
};

type WizardStep = "register" | "org" | "model";

type SimpleIconLike = {
  path: string;
  hex: string;
};

const PROVIDER_ICON_MAP: Record<string, SimpleIconLike> = {
  openai: siOpenaigym,
  anthropic: siAnthropic,
  google: siGooglegemini,
  deepseek: siDeepseek,
  ollama: siOllama,
  "openai-compatible": siOpenrouter,
};

function ProviderOption({ provider }: { provider: ProviderDef }) {
  const icon = PROVIDER_ICON_MAP[provider.type];

  return (
    <div className="flex w-full min-w-0 items-center gap-2.5">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
        {icon ? (
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            role="img"
            aria-hidden="true"
            style={{ color: `#${icon.hex}` }}
          >
            <path d={icon.path} fill="currentColor" />
          </svg>
        ) : (
          <span className="text-[10px] font-semibold tracking-wide text-muted-foreground">
            {provider.name.slice(0, 2).toUpperCase()}
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-current">
          {provider.name}
        </p>
        <p className="truncate text-xs leading-5 text-current/70">
          {provider.description}
        </p>
      </div>
    </div>
  );
}

export default function SetupPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const t = useTranslations("setup");

  const { data: authStatus } = useAuthStatus();
  const { data: providers = [] } = useProviders();
  const registerMutation = useRegister();
  const createModelMutation = useCreateModelConfig();

  const [step, setStep] = useState<WizardStep>("register");
  const [selected, setSelected] = useState<ProviderDef | null>(null);
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
    if (authStatus.step === "needs-org") setStep("org");
    else if (authStatus.step === "needs-model") setStep("model");
  }, [authStatus]);

  useEffect(() => {
    if (step === "model" && !selected && providers.length > 0) {
      setSelected(providers[0] ?? null);
    }
  }, [providers, selected, step]);

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

  const handleModelSubmit = async (data: ModelConfigInput) => {
    await createModelMutation.mutateAsync(data);
    await queryClient.invalidateQueries({ queryKey: ["auth", "status"] });
    router.push("/assistant");
  };

  return (
    <AuthShellLayout>
      <div className={cn("w-full max-w-[420px]")}>
        <div className="pr-1">
          <span className="mb-4 inline-flex items-center rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
            {t("getStarted")}
          </span>
          {step === "register" && (
            <Card>
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
                      className="mt-1 bg-(--shell-accent) text-white hover:opacity-90"
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
                setStep("model");
              }}
            />
          )}

          {step === "model" && (
            <Card>
              <CardHeader className="space-y-1">
                <CardTitle>{t("chooseProvider")}</CardTitle>
                <CardDescription>
                  {t("chooseProviderDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-3">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-xs font-semibold tracking-wide text-muted-foreground">
                      {t("provider")}
                    </p>
                    <Select
                      value={selected?.type ?? ""}
                      onValueChange={(type) => {
                        const provider = providers.find(
                          (item) => item.type === type,
                        );
                        setSelected(provider ?? null);
                      }}
                    >
                      <SelectTrigger className="h-12 px-3 text-left [&>span]:flex [&>span]:w-full [&>span]:items-center [&>span]:text-left [&>svg]:text-muted-foreground">
                        {selected ? (
                          <ProviderOption provider={selected} />
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {t("chooseProviderPlaceholder")}
                          </span>
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        {providers.map((provider) => (
                          <SelectItem
                            key={provider.type}
                            value={provider.type}
                            className="py-2.5 pr-9"
                          >
                            <ProviderOption provider={provider} />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {selected ? (
                    <div className="pr-1">
                      <h3 className="mb-3 border-t border-border pt-4 text-sm font-semibold tracking-wide text-foreground/80">
                        {t("modelConfig")}
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
                              ? t("saveFailed")
                              : null
                        }
                      />
                    </div>
                  ) : (
                    <div className="flex min-h-[220px] items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
                      {t("chooseProviderToStart")}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AuthShellLayout>
  );
}
