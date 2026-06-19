"use client";

import { NewMessageView } from "@/components/im/new-message-view";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";

export default function NewMessagePage() {
  return (
    <AppShellLayout>
      <NewMessageView />
    </AppShellLayout>
  );
}
