"use client";

import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { AreaPlaceholder } from "@/components/shell/area-placeholder";

export default function MorePage() {
  return (
    <AppShellLayout>
      <AreaPlaceholder
        titleKey="placeholder.moreTitle"
        bodyKey="placeholder.moreBody"
      />
    </AppShellLayout>
  );
}
