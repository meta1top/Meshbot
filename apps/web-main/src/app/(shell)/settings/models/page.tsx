"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@meshbot/design";
import type { OrgModelConfigView } from "@meshbot/types";
import { PageHeader, PageShellView } from "@meshbot/web-common/shell";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import {
  ModelFormPanel,
  type ModelFormValues,
  modelFormValuesToCreateInput,
} from "@/components/models/model-form-panel";
import { deriveModelName } from "@/components/models/model-form-panel.helpers";
import { ApiError } from "@/lib/api";
import { useProfile } from "@/rest/auth";
import {
  useCreateModelConfig,
  useDeleteModelConfig,
  useModelConfigs,
  useUpdateModelConfig,
} from "@/rest/model-config";

/** 组织级模型配置管理页：列表 + 新建/编辑/删除 + enabled 即时开关；非 owner 只读。 */
export default function ModelsSettingsPage() {
  const t = useTranslations("models");
  const tSettings = useTranslations("settings");
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
        await createConfig.mutateAsync(modelFormValuesToCreateInput(values));
      } else if (panel) {
        await updateConfig.mutateAsync({
          configId: panel.id,
          input: {
            name: deriveModelName({
              name: values.name,
              providerType: values.providerType,
              model: values.model,
            }),
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
    <PageShellView header={<PageHeader title={tSettings("nav.models")} />}>
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
              <div className="text-sm text-muted-foreground">
                {t("loading")}
              </div>
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
                            {c.enabled
                              ? t("statusEnabled")
                              : t("statusDisabled")}
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
    </PageShellView>
  );
}
