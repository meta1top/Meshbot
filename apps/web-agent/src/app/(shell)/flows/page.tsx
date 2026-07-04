"use client";

import { Workflow } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageShell } from "@/components/layouts/page-shell";

/** 流程区(留位):人机协作流程平台占位,后续接入。 */
export default function FlowsPage() {
  const t = useTranslations("flows");
  return (
    <PageShell>
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
