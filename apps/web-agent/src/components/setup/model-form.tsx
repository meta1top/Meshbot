"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Alert,
  AlertDescription,
  Button,
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
  SelectValue,
} from "@meshbot/design";
import type { ModelConfigInput, ProviderDef } from "@meshbot/web-common";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type ModelConfigFormValues = {
  name?: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** 表单里以字符串收，提交时转 number；留空表示由后端按 spec 解析。 */
  contextWindow?: string;
};

interface ModelFormProps {
  provider: ProviderDef;
  onSubmit: (data: ModelConfigInput) => Promise<void>;
  submitting: boolean;
  error: string | null;
}

export default function ModelForm({
  provider,
  onSubmit,
  submitting,
  error,
}: ModelFormProps) {
  const [customModel, setCustomModel] = useState(false);
  const t = useTranslations("modelForm");
  const modelConfigSchema = z.object({
    name: z.string().optional(),
    model: z.string().min(1, t("validation.modelRequired")),
    apiKey: z.string().min(1, t("validation.apiKeyRequired")),
    baseUrl: z.string().optional(),
    // 表单收字符串：留空 → 由后端按 spec 解析；非空必须是正整数
    contextWindow: z
      .string()
      .optional()
      .refine(
        (v) => !v || (/^\d+$/.test(v) && Number(v) > 0),
        t("validation.contextWindowPositive"),
      ),
  });

  const form = useForm<ModelConfigFormValues>({
    resolver: zodResolver(modelConfigSchema),
    defaultValues: {
      name: "",
      model: provider.models[0] ?? "",
      apiKey: "",
      baseUrl: provider.default_base_url,
      contextWindow: "",
    },
  });

  const watchedModel = form.watch("model");

  const handleFormSubmit = (values: ModelConfigFormValues) => {
    onSubmit({
      providerType: provider.type,
      name: values.name || `${provider.name} - ${values.model}`,
      model: values.model,
      apiKey: values.apiKey,
      baseUrl: values.baseUrl || undefined,
      contextWindow: values.contextWindow
        ? Number(values.contextWindow)
        : undefined,
    });
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleFormSubmit)}
        className="flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("name")}{" "}
                <span className="text-muted-foreground">({t("optional")})</span>
              </FormLabel>
              <FormControl>
                <Input
                  placeholder={`${provider.name} - ${watchedModel || "..."}`}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="model"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("model")} <span className="text-destructive">*</span>
              </FormLabel>
              {customModel || provider.models.length === 0 ? (
                <FormControl>
                  <Input placeholder={t("modelInputPlaceholder")} {...field} />
                </FormControl>
              ) : (
                <div className="flex gap-2">
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder={t("selectModel")} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {provider.models.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => setCustomModel(true)}
                    className="whitespace-nowrap"
                  >
                    {t("custom")}
                  </Button>
                </div>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="apiKey"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("apiKey")} <span className="text-destructive">*</span>
              </FormLabel>
              <FormControl>
                <Input type="password" placeholder="sk-..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="baseUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("apiEndpoint")}{" "}
                <span className="text-muted-foreground">({t("optional")})</span>
              </FormLabel>
              <FormControl>
                <Input placeholder={provider.default_base_url} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="contextWindow"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("contextWindow")}{" "}
                <span className="text-muted-foreground">({t("optional")})</span>
              </FormLabel>
              <FormControl>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  placeholder={t("contextWindowPlaceholder")}
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                {t("contextWindowHint")}
              </p>
              <FormMessage />
            </FormItem>
          )}
        />

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          type="submit"
          className="mt-2 bg-(--shell-accent) text-white hover:opacity-90"
          disabled={submitting}
        >
          {submitting ? t("saving") : t("saveAndStart")}
        </Button>
      </form>
    </Form>
  );
}
