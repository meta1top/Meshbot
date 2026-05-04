"use client";

import type { ModelConfigInput, ProviderDef } from "@anybot/common";
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
} from "@anybot/design";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const modelConfigSchema = z.object({
  name: z.string().optional(),
  model: z.string().min(1, "请选择或输入模型"),
  apiKey: z.string().min(1, "请输入 API Key"),
  baseUrl: z.string().optional(),
});

type ModelConfigFormValues = z.infer<typeof modelConfigSchema>;

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

  const form = useForm<ModelConfigFormValues>({
    resolver: zodResolver(modelConfigSchema),
    defaultValues: {
      name: "",
      model: provider.models[0] ?? "",
      apiKey: "",
      baseUrl: provider.default_base_url,
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
                名称 <span className="text-muted-foreground">(可选)</span>
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
                模型标识 <span className="text-destructive">*</span>
              </FormLabel>
              {customModel || provider.models.length === 0 ? (
                <FormControl>
                  <Input placeholder="输入模型名，如 gpt-4o" {...field} />
                </FormControl>
              ) : (
                <div className="flex gap-2">
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="选择模型" />
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
                    自定义
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
                API Key <span className="text-destructive">*</span>
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
                API 端点 <span className="text-muted-foreground">(选填)</span>
              </FormLabel>
              <FormControl>
                <Input placeholder={provider.default_base_url} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="mt-2" disabled={submitting}>
          {submitting ? "保存中..." : "保存并开始"}
        </Button>
      </form>
    </Form>
  );
}
