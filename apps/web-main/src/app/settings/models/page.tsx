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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import type { OrgModelConfigView } from "@meshbot/types";
import type { OrgModelConfigCreateInput } from "@meshbot/types-main";
import { PROVIDERS } from "@meshbot/web-common";
import { useTranslations } from "next-intl";
import { forwardRef, useState } from "react";
import { z } from "zod";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ApiError } from "@/lib/api";
import { useProfile } from "@/rest/auth";
import {
  useCreateModelConfig,
  useDeleteModelConfig,
  useModelConfigs,
  useUpdateModelConfig,
} from "@/rest/model-config";

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
function buildFormSchema(requireApiKey: boolean) {
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
type ModelFormValues = z.infer<ReturnType<typeof buildFormSchema>>;

interface ModelFormPanelProps {
  mode: "create" | "edit";
  initial: OrgModelConfigView | null;
  onCancel: () => void;
  onSubmit: (values: ModelFormValues) => Promise<void>;
  submitting: boolean;
  error: string | null;
}

/** 新建 / 编辑配置面板（内嵌 Card，非 Dialog——项目当前无 Dialog 组件）。 */
function ModelFormPanel({
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

/** 组织级模型配置管理页：列表 + 新建/编辑/删除 + enabled 即时开关；非 owner 只读。 */
export default function ModelsSettingsPage() {
  const t = useTranslations("models");
  const profile = useProfile();
  const activeOrg = profile.data?.activeOrg ?? null;
  const isOwner = activeOrg?.role === "owner";

  const {
    data: configs = [],
    isPending,
    error,
  } = useModelConfigs(activeOrg?.id ?? null);
  const createConfig = useCreateModelConfig(activeOrg?.id ?? "");
  const updateConfig = useUpdateModelConfig(activeOrg?.id ?? "");
  const deleteConfig = useDeleteModelConfig(activeOrg?.id ?? "");

  const [panel, setPanel] = useState<"create" | OrgModelConfigView | null>(
    null,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** enabled 开关等行内即时变更的失败提示（页面顶部可消除错误条）。 */
  const [actionError, setActionError] = useState<string | null>(null);

  const closePanel = () => {
    setPanel(null);
    setFormError(null);
  };

  const handleSubmit = async (values: ModelFormValues) => {
    setFormError(null);
    const contextWindow = values.contextWindow
      ? Number(values.contextWindow)
      : undefined;
    try {
      if (panel === "create") {
        const input: OrgModelConfigCreateInput = {
          name: values.name,
          providerType: values.providerType,
          model: values.model,
          apiKey: values.apiKey ?? "",
          baseUrl: values.baseUrl || undefined,
          contextWindow,
        };
        await createConfig.mutateAsync(input);
      } else if (panel) {
        await updateConfig.mutateAsync({
          configId: panel.id,
          input: {
            name: values.name,
            providerType: values.providerType,
            model: values.model,
            apiKey: values.apiKey || undefined,
            baseUrl: values.baseUrl || undefined,
            contextWindow,
          },
        });
      }
      closePanel();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t("saveFailed"));
    }
  };

  const toggleEnabled = (config: OrgModelConfigView) => {
    setActionError(null);
    updateConfig.mutate(
      {
        configId: config.id,
        input: { enabled: !config.enabled },
      },
      {
        onError: (err) => {
          setActionError(
            err instanceof ApiError ? err.message : t("toggleFailed"),
          );
        },
      },
    );
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteConfig.mutateAsync(deleteTarget);
      setDeleteTarget(null);
    } catch (err) {
      // 失败保持弹窗打开展示错误，可重试 / 取消
      setDeleteError(err instanceof ApiError ? err.message : t("deleteFailed"));
    }
  };

  const saving = createConfig.isPending || updateConfig.isPending;

  if (!activeOrg) {
    return <div className="text-sm text-muted-foreground">{t("noOrg")}</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{actionError}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setActionError(null)}
            >
              {t("dismiss")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t("title")}</CardTitle>
          {isOwner ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setFormError(null);
                setPanel("create");
              }}
            >
              {t("create")}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {error instanceof Error ? error.message : t("loadFailed")}
              </AlertDescription>
            </Alert>
          ) : isPending ? (
            <div className="text-sm text-muted-foreground">{t("loading")}</div>
          ) : configs.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t("empty")}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colProvider")}</TableHead>
                  <TableHead>{t("colModel")}</TableHead>
                  <TableHead>{t("colApiKey")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  {isOwner ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {configs.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.providerType}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.model}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.apiKeyMasked}
                    </TableCell>
                    <TableCell>
                      {isOwner ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={updateConfig.isPending}
                          onClick={() => toggleEnabled(c)}
                        >
                          {c.enabled ? t("statusEnabled") : t("statusDisabled")}
                        </Button>
                      ) : c.enabled ? (
                        t("statusEnabled")
                      ) : (
                        t("statusDisabled")
                      )}
                    </TableCell>
                    {isOwner ? (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setFormError(null);
                              setPanel(c);
                            }}
                          >
                            {t("edit")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleteTarget(c.id);
                            }}
                          >
                            {t("delete")}
                          </Button>
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isOwner && panel != null ? (
        <ModelFormPanel
          // key 强制切换目标（编辑 A → 编辑 B / 切新建）时重挂表单，
          // 否则 react-hook-form 仍持旧 defaultValues，提交会把 A 的值写进 B
          key={panel === "create" ? "create" : panel.id}
          mode={panel === "create" ? "create" : "edit"}
          initial={panel === "create" ? null : panel}
          onCancel={closePanel}
          onSubmit={handleSubmit}
          submitting={saving}
          error={formError}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget != null}
        title={t("deleteConfirmTitle")}
        description={t("deleteConfirmDescription")}
        confirmText={t("delete")}
        cancelText={t("cancel")}
        loading={deleteConfig.isPending}
        destructive
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
