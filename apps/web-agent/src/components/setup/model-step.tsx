"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@meshbot/design";
import type { ModelConfigInput, ProviderDef } from "@meshbot/web-common";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  siAnthropic,
  siDeepseek,
  siGooglegemini,
  siOllama,
  siOpenaigym,
  siOpenrouter,
} from "simple-icons";
import ModelForm from "@/components/setup/model-form";
import { useCreateModelConfig, useProviders } from "@/rest/model-config";

type SimpleIconLike = { path: string; hex: string };

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

interface ModelStepProps {
  onDone: () => void;
}

export function ModelStep({ onDone }: ModelStepProps) {
  const t = useTranslations("setup");
  const { data: providers = [] } = useProviders();
  const createModelMutation = useCreateModelConfig();
  const [selected, setSelected] = useState<ProviderDef | null>(null);

  useEffect(() => {
    if (!selected && providers.length > 0) {
      setSelected(providers[0] ?? null);
    }
  }, [providers, selected]);

  const handleSubmit = async (data: ModelConfigInput) => {
    await createModelMutation.mutateAsync(data);
    onDone();
  };

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle>{t("chooseProvider")}</CardTitle>
        <CardDescription>{t("chooseProviderDescription")}</CardDescription>
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
                const provider = providers.find((item) => item.type === type);
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
                onSubmit={handleSubmit}
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
  );
}
