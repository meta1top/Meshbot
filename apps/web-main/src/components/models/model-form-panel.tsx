"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import type { OrgModelConfigView } from "@meshbot/types";
import type { OrgModelConfigCreateInput } from "@meshbot/types-main";
import { PROVIDERS } from "@meshbot/web-common";
import { useTranslations } from "next-intl";
import { forwardRef, useState } from "react";
import { useFormContext } from "react-hook-form";
import { z } from "zod";
import {
  deriveModelName,
  resolveProviderPreset,
} from "./model-form-panel.helpers";

/**
 * provider 下拉——Radix `Select` 用 `value`/`onValueChange`（非原生 `onChange`）,
 * 不能直接当 `FormItem` 单子节点被 cloneElement 注入 react-hook-form field,
 * 用受控包装把 `onChange` 桥接到 `onValueChange`。
 *
 * 切换供应商时顺带把 `model` / `baseUrl` 重置为新供应商预设（下拉首项 /
 * default_base_url）——经 `useFormContext` 拿 `setValue`。仅用户交互触发,
 * 不影响首屏（create 初值 / edit 已存值）。
 */
const ProviderSelect = forwardRef<
  HTMLButtonElement,
  { value?: string; onChange?: (value: string) => void; placeholder: string }
>(({ value, onChange, placeholder }, ref) => {
  const { setValue } = useFormContext<ModelFormValues>();
  const handleChange = (next: string) => {
    onChange?.(next);
    const preset = resolveProviderPreset(next);
    setValue("model", preset?.models[0] ?? "", { shouldValidate: true });
    setValue("baseUrl", preset?.default_base_url ?? "");
  };
  return (
    <Select value={value} onValueChange={handleChange}>
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
 * 模型字段——供应商有预设模型时渲染下拉（+「自定义」入口切手填）;
 * 无预设模型（ollama / openai-compatible）或初值不在预设列表 / 已切自定义时手填。
 * 由 `FormItem` 注入 `value`/`onChange`。父组件用 `key={providerType}` 在切换
 * 供应商时重挂本组件,重置自定义态（此时 model 已被 ProviderSelect 同步重置为首项）。
 */
const ModelField = forwardRef<
  HTMLButtonElement,
  {
    value?: string;
    onChange?: (value: string) => void;
    models: readonly string[];
    selectPlaceholder: string;
    inputPlaceholder: string;
    customLabel: string;
  }
>(
  (
    {
      value,
      onChange,
      models,
      selectPlaceholder,
      inputPlaceholder,
      customLabel,
    },
    ref,
  ) => {
    // 初值不在预设列表（自定义 / 冷门模型）→ 直接手填,避免下拉选不中
    const [custom, setCustom] = useState(
      () => !!value && !models.includes(value),
    );
    if (models.length === 0 || custom) {
      return (
        <Input
          value={value ?? ""}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={inputPlaceholder}
        />
      );
    }
    return (
      <div className="flex gap-2">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger ref={ref} className="flex-1">
            <SelectValue placeholder={selectPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="link"
          className="whitespace-nowrap"
          onClick={() => setCustom(true)}
        >
          {customLabel}
        </Button>
      </div>
    );
  },
);
ModelField.displayName = "ModelField";

/**
 * 表单层 Schema（区别于 API 请求体 `OrgModelConfigCreateInput`）:
 * `name` 选填（留空提交时由 `deriveModelName` 生成）;`contextWindow` 表单收字符串,
 * 提交转数字;`apiKey` 编辑态可选（留空 = 不换）,新建态必填。
 */
export function buildFormSchema(requireApiKey: boolean) {
  return z.object({
    name: z
      .string()
      .max(64, { message: "validation.stringTooLong" })
      .optional(),
    providerType: z.string().min(1, { message: "validation.required" }),
    model: z
      .string()
      .min(1, { message: "validation.required" })
      .max(128, { message: "validation.stringTooLong" }),
    apiKey: requireApiKey
      ? z
          .string()
          .min(1, { message: "validation.required" })
          .max(512, { message: "validation.stringTooLong" })
      : z.string().max(512, { message: "validation.stringTooLong" }).optional(),
    baseUrl: z
      .string()
      .max(255, { message: "validation.stringTooLong" })
      .optional(),
    contextWindow: z
      .string()
      .optional()
      .refine((v) => !v || (/^\d+$/.test(v) && Number(v) > 0), {
        message: "models.contextWindowPositive",
      }),
  });
}
export type ModelFormValues = z.infer<ReturnType<typeof buildFormSchema>>;

/**
 * 表单值 → 创建入参:`name` 空则按供应商+模型自动生成;`contextWindow` 空串转
 * `undefined`、非空转数字;`baseUrl` 空串转 `undefined`;`apiKey` 兜底空串。
 */
export function modelFormValuesToCreateInput(
  values: ModelFormValues,
): OrgModelConfigCreateInput {
  return {
    name: deriveModelName({
      name: values.name,
      providerType: values.providerType,
      model: values.model,
    }),
    providerType: values.providerType,
    model: values.model,
    apiKey: values.apiKey ?? "",
    baseUrl: values.baseUrl || undefined,
    contextWindow: values.contextWindow
      ? Number(values.contextWindow)
      : undefined,
  };
}

export interface ModelFormPanelProps {
  mode: "create" | "edit";
  initial: OrgModelConfigView | null;
  onCancel: () => void;
  onSubmit: (values: ModelFormValues) => Promise<void>;
  submitting: boolean;
  error: string | null;
}

/**
 * 表单字段体——拆成 `<Form>` 子组件,用 `useFormContext` 读 `providerType`
 * 联动 model 字段（下拉/手填 + key 重挂）。
 */
function ModelFormFields({
  mode,
  initial,
}: {
  mode: "create" | "edit";
  initial: OrgModelConfigView | null;
}) {
  const t = useTranslations("models");
  const { watch } = useFormContext<ModelFormValues>();
  const providerType = watch("providerType");
  const models = resolveProviderPreset(providerType)?.models ?? [];

  return (
    <>
      <FormItem
        name="name"
        label={t("fieldNameOptional")}
        description={t("fieldNameHint")}
      >
        <Input placeholder={t("fieldNamePlaceholder")} />
      </FormItem>
      <FormItem name="providerType" label={t("fieldProvider")}>
        <ProviderSelect placeholder={t("fieldProviderPlaceholder")} />
      </FormItem>
      <FormItem name="model" label={t("fieldModel")}>
        <ModelField
          key={providerType}
          models={models}
          selectPlaceholder={t("fieldModelSelectPlaceholder")}
          inputPlaceholder={t("fieldModelPlaceholder")}
          customLabel={t("fieldModelCustom")}
        />
      </FormItem>
      <FormItem
        name="apiKey"
        label={t("fieldApiKey")}
        description={
          mode === "edit"
            ? t("fieldApiKeyEditHint", { masked: initial?.apiKeyMasked ?? "" })
            : undefined
        }
      >
        <Input
          type="password"
          placeholder={
            mode === "edit" ? (initial?.apiKeyMasked ?? "") : "sk-..."
          }
        />
      </FormItem>
      <FormItem name="baseUrl" label={t("fieldBaseUrl")}>
        <Input placeholder={t("fieldBaseUrlPlaceholder")} />
      </FormItem>
      <FormItem name="contextWindow" label={t("fieldContextWindow")}>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          placeholder={t("fieldContextWindowPlaceholder")}
        />
      </FormItem>
    </>
  );
}

/** 新建 / 编辑配置面板（内嵌 Card,非 Dialog——项目当前无 Dialog 组件）。 */
export function ModelFormPanel({
  mode,
  initial,
  onCancel,
  onSubmit,
  submitting,
  error,
}: ModelFormPanelProps) {
  const t = useTranslations("models");
  const schema = useSchema(buildFormSchema(mode === "create"));
  // create 模式默认选中 PROVIDERS[0],model/baseUrl 一并按其预设预填,进来即可用态
  const createPreset = resolveProviderPreset(PROVIDERS[0]?.type ?? "");

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {mode === "create" ? t("createTitle") : t("editTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Form
          schema={schema}
          defaultValues={{
            name: initial?.name ?? "",
            providerType: initial?.providerType ?? PROVIDERS[0]?.type ?? "",
            model: initial?.model ?? createPreset?.models[0] ?? "",
            apiKey: "",
            baseUrl: initial?.baseUrl ?? createPreset?.default_base_url ?? "",
            contextWindow: initial?.contextWindow
              ? String(initial.contextWindow)
              : "",
          }}
          onSubmit={onSubmit}
          className="flex flex-col gap-4"
        >
          <ModelFormFields mode={mode} initial={initial} />

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? t("saving") : t("save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={submitting}
            >
              {t("cancel")}
            </Button>
          </div>
        </Form>
      </CardContent>
    </Card>
  );
}
