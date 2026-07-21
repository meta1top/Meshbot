"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import {
  type ModelConfigInput,
  modelConfigSchema,
  PROVIDERS,
} from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { forwardRef } from "react";
import { useFormContext } from "react-hook-form";
import { type ZodType, z } from "zod";
import {
  buildModelConfigPayload,
  type ModelConfigFormValues,
} from "@/lib/model-config-form";
import type { ModelConfig } from "@/rest/model-config";

/**
 * provider 下拉——Radix `Select` 用 `value`/`onValueChange`（非原生 `onChange`），
 * `FormItem` 的 `cloneElement` 会把 `field.onChange` 直接注入这里的 `onChange` prop，
 * 内部再桥接给 `onValueChange`；切换供应商顺带把 `model`/`baseUrl` 重置为新供应商
 * 预设（经 `useFormContext` 拿 `setValue`），仅用户交互触发，不影响首屏取值。
 */
const ProviderSelect = forwardRef<
  HTMLButtonElement,
  {
    value?: string;
    onChange?: (value: string) => void;
    placeholder: string;
    disabled?: boolean;
  }
>(({ value, onChange, placeholder, disabled }, ref) => {
  const { setValue } = useFormContext<ModelConfigFormSchemaValues>();
  const handleChange = (next: string) => {
    if (next === value) return;
    onChange?.(next);
    const preset = PROVIDERS.find((p) => p.type === next);
    setValue("model", preset?.models[0] ?? "", {
      shouldValidate: Boolean(preset?.models[0]),
    });
    setValue("baseUrl", preset?.default_base_url ?? "");
  };
  return (
    <Select value={value} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger ref={ref}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {PROVIDERS.map((p) => (
          <SelectItem key={p.type} value={p.type}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});
ProviderSelect.displayName = "ProviderSelect";

/**
 * 表单层 Schema：在共享 `modelConfigSchema`（`libs/types-agent`）基础上局部
 * extend——`name` 放开必填（留空 = 按供应商+模型自动生成，交
 * `buildModelConfigPayload` 兜底，对齐占位符文案）；`contextWindow` 原为
 * `z.number()`，表单以字符串收集（DOM input 天然是字符串），这里包一层字符串
 * 校验，提交时经 `buildModelConfigPayload` 转回数字；编辑态 `apiKey` 放开必填
 * （留空 = 不更改当前密钥，对齐后端 `modelConfigUpdateSchema` 的可选语义）。
 */
function buildFormSchema(mode: "create" | "edit") {
  const base = modelConfigSchema.extend({
    name: z.string().optional(),
    contextWindow: z
      .string()
      .optional()
      .refine((v) => !v || (/^\d+$/.test(v) && Number(v) > 0), {
        message: "modelForm.contextWindowPositive",
      }),
  });
  return mode === "edit"
    ? base.extend({ apiKey: z.string().optional() })
    : base;
}
type ModelConfigFormSchemaValues = z.infer<ReturnType<typeof buildFormSchema>>;

export interface ModelConfigFormProps {
  /** 编辑态初值；不传 = 新建（供应商可选、apiKey 必填）。 */
  initial?: Pick<
    ModelConfig,
    "providerType" | "name" | "model" | "baseUrl" | "contextWindow"
  >;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: ModelConfigInput) => Promise<void>;
  onCancel?: () => void;
}

/** 本地模型配置表单（新建/编辑复用）。云端条目只读，不经此表单。 */
export function ModelConfigForm({
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: ModelConfigFormProps) {
  const t = useTranslations("modelForm");
  const mode: "create" | "edit" = initial ? "edit" : "create";
  const defaultProvider =
    PROVIDERS.find((p) => p.type === initial?.providerType) ?? PROVIDERS[0];
  const schema = useSchema(
    buildFormSchema(mode),
  ) as unknown as ZodType<ModelConfigFormSchemaValues>;

  const handle = async (values: ModelConfigFormSchemaValues) => {
    const provider =
      PROVIDERS.find((p) => p.type === values.providerType) ?? defaultProvider;
    const formValues: ModelConfigFormValues = {
      name: values.name,
      model: values.model,
      apiKey: values.apiKey ?? "",
      baseUrl: values.baseUrl,
      contextWindow: values.contextWindow,
    };
    await onSubmit(buildModelConfigPayload(formValues, provider));
  };

  return (
    <Form
      schema={schema}
      defaultValues={{
        providerType: initial?.providerType ?? defaultProvider.type,
        name: initial?.name ?? "",
        model: initial?.model ?? defaultProvider.models[0] ?? "",
        apiKey: "",
        baseUrl: initial?.baseUrl ?? defaultProvider.default_base_url,
        contextWindow: initial?.contextWindow
          ? String(initial.contextWindow)
          : "",
      }}
      onSubmit={handle}
      className="flex flex-col gap-4"
    >
      <FormItem name="providerType" label={t("provider")}>
        <ProviderSelect
          placeholder={t("selectProvider")}
          disabled={mode === "edit"}
        />
      </FormItem>
      <FormItem name="name" label={t("name")}>
        <Input placeholder={t("namePlaceholder")} />
      </FormItem>
      <FormItem name="model" label={t("model")}>
        <Input placeholder={t("modelPlaceholder")} />
      </FormItem>
      <FormItem
        name="apiKey"
        label={t("apiKey")}
        description={mode === "edit" ? t("apiKeyEditHint") : undefined}
      >
        <Input type="password" placeholder={t("apiKeyPlaceholder")} />
      </FormItem>
      <FormItem name="baseUrl" label={t("baseUrl")}>
        <Input placeholder={t("baseUrlPlaceholder")} />
      </FormItem>
      <FormItem name="contextWindow" label={t("contextWindow")}>
        <Input placeholder={t("contextWindowPlaceholder")} />
      </FormItem>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? t("saving") : t("submit")}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
        )}
      </div>
    </Form>
  );
}
