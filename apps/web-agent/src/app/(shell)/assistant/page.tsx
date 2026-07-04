"use client";

import { useSetAtom } from "jotai";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useRef } from "react";
import { currentAssistantSessionIdAtom } from "@/atoms/right-zone";
import { PageShell } from "@/components/layouts/page-shell";
import { AssistantConversationBody } from "@/components/session/assistant-conversation-body";
import { SessionHeader } from "@/components/session/session-header";
import { AssistantSidebar } from "@/components/shell/assistant-sidebar";

function AssistantView() {
  const t = useTranslations("assistantSidebar");
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const scrollRef = useRef<HTMLDivElement>(null);

  // 把当前主会话 id 同步到右区 atom，供 RightZone 工具面板取用；离开/无 id 时置 null
  const setCurrentAssistantSessionId = useSetAtom(
    currentAssistantSessionIdAtom,
  );
  useEffect(() => {
    setCurrentAssistantSessionId(id ?? null);
    return () => setCurrentAssistantSessionId(null);
  }, [id, setCurrentAssistantSessionId]);

  return (
    <PageShell
      sidebar={<AssistantSidebar />}
      scrollContainerRef={scrollRef}
      header={id ? <SessionHeader sessionId={id} /> : undefined}
    >
      {id ? (
        <AssistantConversationBody id={id} scrollRef={scrollRef} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("emptyHint")}
        </div>
      )}
    </PageShell>
  );
}

/** /assistant 页。useSearchParams 需 Suspense 边界(静态导出要求)。 */
export default function AssistantPage() {
  return (
    <Suspense fallback={null}>
      <AssistantView />
    </Suspense>
  );
}
