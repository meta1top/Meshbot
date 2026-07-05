"use client";

import { Button, Card, CardContent } from "@meshbot/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DragRegion } from "@/components/drag-region";
import { WorkspaceSidebar } from "@/components/shell/workspace-sidebar";
import { ACCENT_BTN } from "@/lib/ui";
import { useCloudWebUrl } from "@/rest/auth";

/**
 * 已登录但组织无可用模型配置时的只读提示页：模型编辑已收敛到云端 web-main，
 * 本地仅展示提示卡（外链跳转云端配置 + 刷新重新拉取 model-configs）。
 * 不带频道侧栏与随手问 dock（AuthGuard 在 root 级条件渲染，拿不到 (shell)/layout，
 * 故自拼轻量壳）。刷新命中新配置后由 AuthGuard 的 model-configs 查询自动检测并切回
 * 正常内容，无需手动 redirect。
 */
export function ModelSetupGate() {
  const t = useTranslations("modelSetupGate");
  const cloudWebUrl = useCloudWebUrl();
  const queryClient = useQueryClient();
  const [, setSlotEl] = useState<HTMLElement | null>(null);

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

  return (
    <main className="titlebar-safe flex h-screen flex-col bg-(--surface-0) text-foreground">
      <DragRegion />
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar sublistSlotRef={setSlotEl} />
        <div className="relative flex min-h-0 flex-1 overflow-hidden pr-1.5 pb-1.5">
          <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-(--shell-radius) bg-(--shell-content)">
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
    </main>
  );
}
