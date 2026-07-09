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
import { forwardRef } from "react";
import { z } from "zod";

/**
 * provider 下拉——Radix `Select` 根组件用 `value`/`onValueChange`（非原生 `onChange`），
 * 不能直接当 `FormItem` 单子节点被 cloneElement 注入 react-hook-form 的 field；
 * 用这个受控包装组件把 `onChange` 桥接到 `onValueChange`。
 */
const ProviderSelect = forwardRef<
  HTMLButtonElement,
  { value?: string; onChange?: (value: string) => void; placeholder: string }
>(({ value, onChange, placeholder }, ref) => (
  <Select value={value} onValueChange={onChange}>
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
));
ProviderSelect.displayName = "ProviderSelect";

/**
 * 表单层 Schema（区别于 API 请求体 `OrgModelConfigCreateInput`）：
 * `contextWindow` 表单收字符串（HTML input 原生值），提交时转数字；
 * `apiKey` 编辑态可选（留空 = 不换），新建态必填。
 */
export function buildFormSchema(requireApiKey: boolean) {
  return z.object({
    name: z
      .string()
      .min(1, { message: "validation.required" })
      .max(64, { message: "validation.stringTooLong" }),
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
 * 表单值 → 创建入参：`contextWindow` 空串转 `undefined`、非空转数字；
 * `baseUrl` 空串转 `undefined`；`apiKey` 新建态必填但仍兜底空串。
 * 与 settings/models 页原 `handleSubmit` create 分支的映射保持一致。
 */
export function modelFormValuesToCreateInput(
  values: ModelFormValues,
): OrgModelConfigCreateInput {
  return {
    name: values.name,
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

/** 新建 / 编辑配置面板（内嵌 Card，非 Dialog——项目当前无 Dialog 组件）。 */
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
            model: initial?.model ?? "",
            apiKey: "",
            baseUrl: initial?.baseUrl ?? "",
            contextWindow: initial?.contextWindow
              ? String(initial.contextWindow)
              : "",
          }}
          onSubmit={onSubmit}
          className="flex flex-col gap-4"
        >
          <FormItem name="name" label={t("fieldName")}>
            <Input placeholder={t("fieldNamePlaceholder")} />
          </FormItem>
          <FormItem name="providerType" label={t("fieldProvider")}>
            <ProviderSelect placeholder={t("fieldProviderPlaceholder")} />
          </FormItem>
          <FormItem name="model" label={t("fieldModel")}>
            <Input placeholder={t("fieldModelPlaceholder")} />
          </FormItem>
          <FormItem
            name="apiKey"
            label={t("fieldApiKey")}
            description={
              mode === "edit"
                ? t("fieldApiKeyEditHint", {
                    masked: initial?.apiKeyMasked ?? "",
                  })
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
