"use client";

import {
  Alert,
  AlertDescription,
  Button,
  CardDescription,
  CardTitle,
  cn,
  Input,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useFormContext } from "react-hook-form";
import { z } from "zod";
import { ApiError } from "@/lib/api";
import { useCreateModelConfig } from "@/rest/model-config";

/**
 * 授权向导「添加模型」步的厂商快捷预设——仅本简化表单用（区别于
 * settings/models 完整 `PROVIDERS` 清单）：chip 只是填充 providerType/baseUrl
 * 预设值的快捷方式，字段仍走共享 schema 校验。品牌名不走 i18n（「自定义」除外）。
 */
const PROVIDER_PRESETS = [
  {
    key: "deepseek",
    label: "DeepSeek",
    providerType: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    placeholderModel: "deepseek-chat",
  },
  {
    key: "openai",
    label: "OpenAI",
    providerType: "openai",
    baseUrl: "",
    placeholderModel: "gpt-4o",
  },
  {
    key: "ollama",
    label: "Ollama",
    providerType: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    placeholderModel: "qwen3:8b",
  },
  {
    key: "custom",
    label: "",
    providerType: "openai-compatible",
    baseUrl: "",
    placeholderModel: "",
  },
] as const;

type PresetKey = (typeof PROVIDER_PRESETS)[number]["key"];

function resolvePreset(key: PresetKey) {
  return PROVIDER_PRESETS.find((p) => p.key === key) ?? PROVIDER_PRESETS[0];
}

/** 表单 schema：name 选填（留空提交时取 model 值），baseUrl 仅 custom 预设可编辑。 */
function buildOnboardingSchema() {
  return z.object({
    name: z
      .string()
      .max(64, { message: "validation.stringTooLong" })
      .optional(),
    model: z
      .string()
      .min(1, { message: "validation.required" })
      .max(128, { message: "validation.stringTooLong" }),
    apiKey: z
      .string()
      .min(1, { message: "validation.required" })
      .max(512, { message: "validation.stringTooLong" }),
    baseUrl: z
      .string()
      .max(255, { message: "validation.stringTooLong" })
      .optional(),
  });
}
type OnboardingFormValues = z.infer<ReturnType<typeof buildOnboardingSchema>>;

/**
 * 厂商 chip + model/apiKey/baseUrl(custom 展开)/name 字段体。
 * 必须渲染在 `<Form>` 内——用 `useFormContext` 在切换 chip 时把 baseUrl
 * 重置为新预设值（即便 baseUrl 字段本身未挂载，react-hook-form 的表单值仍会保留该 setValue）。
 */
function ModelPresetPicker({
  presetKey,
  onPick,
}: {
  presetKey: PresetKey;
  onPick: (key: PresetKey) => void;
}) {
  const t = useTranslations("authorize");
  const { setValue } = useFormContext<OnboardingFormValues>();
  const preset = resolvePreset(presetKey);

  const handlePick = (key: PresetKey) => {
    if (key === presetKey) return;
    onPick(key);
    setValue("baseUrl", resolvePreset(key).baseUrl);
  };

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {PROVIDER_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => handlePick(p.key)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              presetKey === p.key
                ? "border-(--shell-accent) bg-(--shell-accent)/10 text-(--shell-accent)"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {p.key === "custom" ? t("model.presetCustom") : p.label}
          </button>
        ))}
      </div>

      <FormItem name="model" label={t("model.fieldModel")}>
        <Input
          placeholder={
            preset.placeholderModel || t("model.fieldModelPlaceholder")
          }
        />
      </FormItem>

      <FormItem name="apiKey" label={t("model.fieldApiKey")}>
        <Input type="password" placeholder="sk-..." />
      </FormItem>

      {presetKey === "custom" && (
        <FormItem name="baseUrl" label={t("model.fieldBaseUrl")}>
          <Input placeholder={t("model.fieldBaseUrlPlaceholder")} />
        </FormItem>
      )}

      <FormItem
        name="name"
        label={t("model.fieldNameOptional")}
        description={t("model.fieldNameHint")}
      >
        <Input placeholder={t("model.fieldNamePlaceholder")} />
      </FormItem>

      <p className="text-xs text-muted-foreground">
        {t("model.contextWindowHint")}
      </p>
    </>
  );
}

/**
 * onboarding「添加模型」步：owner 且组织零模型时渲染，简化版模型表单
 * （厂商 chip 预设 + model/apiKey/baseUrl/name），提交成功调用 `onDone`。
 * `allowSkip`：授权链场景可「跳过」（授权不需要模型）；shell 场景不可跳过。
 * `contextWindow` 不传，云端 `resolveContextWindow` 按模型自动解析。
 */
export function ModelOnboarding({
  orgId,
  onDone,
  allowSkip = true,
}: {
  orgId: string;
  onDone: () => void;
  allowSkip?: boolean;
}) {
  const t = useTranslations("authorize");
  const [presetKey, setPresetKey] = useState<PresetKey>(
    PROVIDER_PRESETS[0].key,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const createMutation = useCreateModelConfig(orgId);
  const schema = useSchema(buildOnboardingSchema());
  const initialPreset = resolvePreset(presetKey);

  const onSubmit = async (values: OnboardingFormValues) => {
    setErrorMessage(null);
    const preset = resolvePreset(presetKey);
    const trimmedName = values.name?.trim();
    try {
      await createMutation.mutateAsync({
        name: trimmedName || values.model,
        providerType: preset.providerType,
        model: values.model,
        apiKey: values.apiKey,
        baseUrl:
          (presetKey === "custom" ? values.baseUrl : preset.baseUrl) ||
          undefined,
      });
      onDone();
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : t("model.createFailed"),
      );
    }
  };

  return (
    <div>
      <div className="space-y-1 pb-3">
        <CardTitle>{t("model.title")}</CardTitle>
        <CardDescription>{t("model.description")}</CardDescription>
      </div>
      <Form
        schema={schema}
        defaultValues={{
          name: "",
          model: "",
          apiKey: "",
          baseUrl: initialPreset.baseUrl,
        }}
        onSubmit={onSubmit}
        className="flex flex-col gap-4"
      >
        <ModelPresetPicker presetKey={presetKey} onPick={setPresetKey} />

        {errorMessage && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        <div className="flex gap-2">
          <Button
            type="submit"
            className="flex-1"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? t("model.creating") : t("model.create")}
          </Button>
          {allowSkip && (
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={onDone}
              disabled={createMutation.isPending}
            >
              {t("model.skip")}
            </Button>
          )}
        </div>
      </Form>
    </div>
  );
}
