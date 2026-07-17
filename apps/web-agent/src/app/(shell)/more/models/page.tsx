"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@meshbot/design";
import type { ModelConfigInput } from "@meshbot/types-agent";
import { PROVIDERS } from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ToolPage } from "@/components/layouts/tool-page";
import { ModelConfigForm } from "@/components/settings/model-config-form";
import { MoreSidebar } from "@/components/shell/more-sidebar";
import { isLocalConfig } from "@/lib/model-config-form";
import type { ModelConfig, ModelConfigUpdate } from "@/rest/model-config";
import { useModelConfigMutations, useModelConfigs } from "@/rest/model-config";

/** 供应商 type → 展示名；未命中预设时原样回退。 */
function providerLabel(providerType: string): string {
  return PROVIDERS.find((p) => p.type === providerType)?.name ?? providerType;
}

/**
 * 「更多」→ 模型：本地模型配置管理页。合并列表按 `source` 区分本地/云端——
 * 本地行可新建/编辑/启停/删除；云端行只读展示（编辑走云端 web-main org 设置）。
 */
export default function ModelsPage() {
  const t = useTranslations("modelSettings");
  const tNav = useTranslations("settingsSidebar");
  const { data: configs, isPending, error } = useModelConfigs();
  const { create, update, setEnabled, remove } = useModelConfigMutations();

  const [panel, setPanel] = useState<"create" | ModelConfig | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelConfig | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const closePanel = () => {
    setPanel(null);
    setFormError(null);
  };

  const handleSubmit = async (payload: ModelConfigInput) => {
    setFormError(null);
    try {
      if (panel === "create") {
        await create.mutateAsync(payload);
      } else if (panel) {
        // providerType 创建后不可改；apiKey 留空表示不更改当前密钥。
        const patch: ModelConfigUpdate = {
          name: payload.name,
          model: payload.model,
          baseUrl: payload.baseUrl,
          contextWindow: payload.contextWindow,
        };
        if (payload.apiKey) patch.apiKey = payload.apiKey;
        await update.mutateAsync({ id: panel.id, patch });
      }
      closePanel();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("saveFailed"));
    }
  };

  const toggleEnabled = (config: ModelConfig) => {
    setActionError(null);
    setEnabled.mutate(
      { id: config.id, enabled: !config.enabled },
      {
        onError: (err) => {
          setActionError(
            err instanceof Error ? err.message : t("toggleFailed"),
          );
        },
      },
    );
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await remove.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("deleteFailed"));
    }
  };

  const saving = create.isPending || update.isPending;
  const list = configs ?? [];

  return (
    <ToolPage
      title={tNav("models")}
      sidebar={<MoreSidebar />}
      actions={
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setFormError(null);
            setPanel("create");
          }}
        >
          {t("newLocalModel")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
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

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {error instanceof Error ? error.message : t("loadFailed")}
            </AlertDescription>
          </Alert>
        ) : isPending ? (
          <div className="text-sm text-muted-foreground">{t("loading")}</div>
        ) : list.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("empty")}</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colProvider")}</TableHead>
                <TableHead>{t("colModel")}</TableHead>
                <TableHead>{t("colSource")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((c) => {
                const local = isLocalConfig(c);
                return (
                  <TableRow key={c.id}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {providerLabel(c.providerType)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.model}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          local
                            ? "bg-foreground/8 text-foreground"
                            : "bg-muted text-muted-foreground"
                        }`}
                        title={local ? undefined : t("cloudReadonlyHint")}
                      >
                        {local ? t("badgeLocal") : t("badgeCloud")}
                      </span>
                    </TableCell>
                    <TableCell>
                      {local ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={setEnabled.isPending}
                          onClick={() => toggleEnabled(c)}
                        >
                          {c.enabled ? t("enable") : t("disable")}
                        </Button>
                      ) : c.enabled ? (
                        t("enable")
                      ) : (
                        t("disable")
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {local ? (
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
                              setDeleteTarget(c);
                            }}
                          >
                            {t("delete")}
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <Sheet
        open={panel != null}
        onOpenChange={(open) => {
          if (!open) closePanel();
        }}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-md"
        >
          <SheetHeader>
            <SheetTitle>
              {panel === "create" ? t("newLocalModel") : t("editTitle")}
            </SheetTitle>
            <SheetDescription>{t("formDescription")}</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {panel != null && (
              <ModelConfigForm
                key={panel === "create" ? "create" : panel.id}
                initial={panel === "create" ? undefined : panel}
                submitting={saving}
                error={formError}
                onSubmit={handleSubmit}
                onCancel={closePanel}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={deleteTarget != null}
        title={t("deleteConfirmTitle")}
        description={
          deleteError ? (
            <span>
              {t("deleteConfirmDescription")}
              <span className="mt-1 block text-[12px] text-destructive">
                {deleteError}
              </span>
            </span>
          ) : (
            t("deleteConfirmDescription")
          )
        }
        confirmText={t("delete")}
        cancelText={t("cancel")}
        loading={remove.isPending}
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
      />
    </ToolPage>
  );
}
