"use client";

import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { AreaPlaceholder } from "@/components/shell/area-placeholder";

export default function MessagesPage() {
  return (
    <AppShellLayout>
      <AreaPlaceholder
        titleKey="placeholder.messagesTitle"
        bodyKey="placeholder.messagesBody"
      />
    </AppShellLayout>
  );
}
