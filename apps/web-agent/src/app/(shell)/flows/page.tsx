"use client";

import { Workflow } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageShell } from "@/components/layouts/page-shell";
import { MoreSidebar } from "@/components/shell/more-sidebar";

/** 流程区(留位):人机协作流程平台占位,后续接入。归「更多」区,二级面板复用 MoreSidebar。 */
export default function FlowsPage() {
  const t = useTranslations("flows");
  return (
    <PageShell sidebar={<MoreSidebar />}>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
          <Workflow className="h-7 w-7" />
        </span>
        <div className="text-[15px] font-semibold text-foreground">
          {t("comingTitle")}
        </div>
        <div className="max-w-[320px] text-[13px] text-muted-foreground">
          {t("comingHint")}
        </div>
      </div>
    </PageShell>
  );
}
