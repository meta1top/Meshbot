"use client";

import { Sparkles } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useRef } from "react";
import { PageShell } from "@/components/layouts/page-shell";
import { AssistantConversationBody } from "@/components/session/assistant-conversation-body";
import { SessionHeader } from "@/components/session/session-header";
import { AssistantSidebar } from "@/components/shell/assistant-sidebar";

/**
 * 远程会话（L3）的标题栏。不复用 SessionHeader——那个组件按 sessionId 查
 * 本地 sessionsAtom，远程会话 id 在本地找不到，会永远卡在标题骨架上。
 */
function RemoteSessionHeader() {
  const t = useTranslations("assistantSidebar");
  return (
    <div className="shrink-0 bg-(--shell-content)">
      <div className="flex h-13 w-full items-center gap-2 border-b border-border px-4 lg:px-6">
        <Sparkles className="h-4 w-4 shrink-0 text-(--shell-accent)" />
        <span className="truncate text-[15px] font-semibold text-foreground">
          {t("remoteSessionTitle")}
        </span>
      </div>
    </div>
  );
}

function AssistantView() {
  const t = useTranslations("assistantSidebar");
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const remoteAgent = searchParams.get("remoteAgent");
  // 远程会话首轮由起手台 create 发起时带入的 streamId：该会话页尚未自己发过
  // 追加消息前，中断只能靠这个 streamId 路由到 B（见 useSessionStream 注释）。
  const streamId = searchParams.get("streamId");
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <PageShell
      sidebar={<AssistantSidebar />}
      scrollContainerRef={scrollRef}
      header={
        remoteAgent && id ? (
          <RemoteSessionHeader />
        ) : id ? (
          <SessionHeader sessionId={id} />
        ) : undefined
      }
    >
      {remoteAgent && id ? (
        <AssistantConversationBody
          id={id}
          scrollRef={scrollRef}
          remoteAgentId={remoteAgent}
          remoteInitialStreamId={streamId}
        />
      ) : id ? (
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
