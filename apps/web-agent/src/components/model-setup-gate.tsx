"use client";

import {
  Button,
  Card,
  CardContent,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@meshbot/design";
import type { ModelConfigInput } from "@meshbot/types-agent";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DragRegion } from "@/components/drag-region";
import { ModelConfigForm } from "@/components/settings/model-config-form";
import { WorkspaceSidebar } from "@/components/shell/workspace-sidebar";
import { ACCENT_BTN } from "@/lib/ui";
import { useCloudWebUrl } from "@/rest/auth";
import { useModelConfigMutations } from "@/rest/model-config";

/**
 * 已登录但无可用模型配置时的引导页：本地或云端组织都能配模型，两者平级——
 * 「新建本地模型」是首选主按钮（内嵌 `ModelConfigForm`，创建成功即用），
 * 「在云端配置」降为次要外链入口，「刷新」保留兜底。
 * 不带频道侧栏与随手问 dock（AuthGuard 在 root 级条件渲染，拿不到 (shell)/layout，
 * 故自拼轻量壳）。本地建模成功后失效 `["model-configs"]`，AuthGuard 的合并列表
 * 查询检测到有 enabled 项即自动切回正常内容，无需手动 redirect。
 */
export function ModelSetupGate() {
  const t = useTranslations("modelSetupGate");
  const cloudWebUrl = useCloudWebUrl();
  const queryClient = useQueryClient();
  const [, setSlotEl] = useState<HTMLElement | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { create } = useModelConfigMutations();

  const openCloudModelSettings = () => {
    if (!cloudWebUrl.data) return;
    window.open(
      `${cloudWebUrl.data.webMainBase}/settings/models`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["model-configs"] });
  };

  const handleCreate = async (payload: ModelConfigInput) => {
    setFormError(null);
    try {
      await create.mutateAsync(payload);
      setFormOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("createFailed"));
    }
  };

  return (
    <main className="titlebar-safe flex h-screen flex-col bg-(--shell-content) text-foreground">
      <DragRegion />
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar sublistSlotRef={setSlotEl} />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-(--shell-content)">
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-4 lg:px-6">
              <Card className="w-full max-w-[480px]">
                <CardContent className="flex flex-col items-center gap-4 pt-6 text-center">
                  <h2 className="text-base font-semibold text-foreground">
                    {t("title")}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t("description")}
                  </p>
                  <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
                    <Button
                      type="button"
                      className={ACCENT_BTN}
                      onClick={() => {
                        setFormError(null);
                        setFormOpen(true);
                      }}
                    >
                      {t("configureLocal")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!cloudWebUrl.data}
                      onClick={openCloudModelSettings}
                    >
                      {t("configureInCloud")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleRefresh}
                    >
                      {t("refresh")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </section>
        </div>
      </div>

      <Sheet
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setFormError(null);
        }}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-md"
        >
          <SheetHeader>
            <SheetTitle>{t("configureLocal")}</SheetTitle>
            <SheetDescription>
              {t("configureLocalDescription")}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <ModelConfigForm
              submitting={create.isPending}
              error={formError}
              onSubmit={handleCreate}
              onCancel={() => setFormOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}
