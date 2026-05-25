"use client";

import { useTranslations } from "next-intl";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";

export default function SchedulePage() {
  const t = useTranslations("schedule");
  return (
    <AppShellLayout>
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("title")}
      </div>
    </AppShellLayout>
  );
}
