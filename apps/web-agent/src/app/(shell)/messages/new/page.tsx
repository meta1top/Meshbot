"use client";

import { NewMessageView } from "@/components/im/new-message-view";
import { PageShell } from "@/components/layouts/page-shell";
import { MessagesSidebar } from "@/components/shell/messages-sidebar";

export default function NewMessagePage() {
  return (
    <PageShell sidebar={<MessagesSidebar />}>
      <NewMessageView />
    </PageShell>
  );
}
