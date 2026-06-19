"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useRef } from "react";
import { ImConversationBody } from "@/components/im/im-conversation-body";
import { ImConversationHeader } from "@/components/im/im-conversation-header";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { AssistantConversationBody } from "@/components/session/assistant-conversation-body";
import { SessionHeader } from "@/components/session/session-header";

function MessagesView() {
  const t = useTranslations("messages");
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const isAssistant = searchParams.get("kind") === "assistant";
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <AppShellLayout
      scrollContainerRef={scrollRef}
      header={
        !id ? undefined : isAssistant ? (
          <SessionHeader sessionId={id} />
        ) : (
          <ImConversationHeader />
        )
      }
    >
      {!id ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("emptyHint")}
        </div>
      ) : isAssistant ? (
        <AssistantConversationBody id={id} scrollRef={scrollRef} />
      ) : (
        <ImConversationBody id={id} scrollRef={scrollRef} />
      )}
    </AppShellLayout>
  );
}

/** /messages 页。useSearchParams 需 Suspense 边界（静态导出要求）。 */
export default function MessagesPage() {
  return (
    <Suspense fallback={null}>
      <MessagesView />
    </Suspense>
  );
}
