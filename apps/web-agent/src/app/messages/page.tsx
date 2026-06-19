"use client";

import { useSetAtom } from "jotai";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useRef } from "react";
import { currentConversationIdAtom, messagesAtom } from "@/atoms/im";
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

  const setCurrentConversationId = useSetAtom(currentConversationIdAtom);
  const setMessages = useSetAtom(messagesAtom);
  // IM 会话 hydration / 复位：仅在看 IM 会话（非助手且有 id）时写入当前会话 id；
  // 助手会话 / 裸 /messages 时复位为 null 并清空消息——否则离开后侧栏旧频道残留高亮，
  // 且离开的会话仍被「当前会话不计未读」吞掉未读。body 卸载不复位，故由 page 统一管。
  useEffect(() => {
    const imId = !isAssistant && id ? id : null;
    setCurrentConversationId(imId);
    if (!imId) setMessages([]);
  }, [id, isAssistant, setCurrentConversationId, setMessages]);

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
