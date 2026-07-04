"use client";

import { useSetAtom } from "jotai";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useRef } from "react";
import { currentConversationIdAtom, messagesAtom } from "@/atoms/im";
import { ImConversationBody } from "@/components/im/im-conversation-body";
import { ImConversationHeader } from "@/components/im/im-conversation-header";
import { PageShell } from "@/components/layouts/page-shell";
import { MessagesSidebar } from "@/components/shell/messages-sidebar";

function MessagesView() {
  const t = useTranslations("messages");
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const isAssistant = searchParams.get("kind") === "assistant";
  const scrollRef = useRef<HTMLDivElement>(null);

  const setCurrentConversationId = useSetAtom(currentConversationIdAtom);
  const setMessages = useSetAtom(messagesAtom);
  // 旧 assistant 链接：客户端重定向到独立助手区（与 /session 跳板同款惯例）。
  // 其余：进 IM 会话时写当前会话 id；裸 /messages 复位清空。
  useEffect(() => {
    if (isAssistant) {
      router.replace(id ? `/assistant?id=${id}` : "/assistant");
      return;
    }
    const imId = id ?? null;
    setCurrentConversationId(imId);
    if (!imId) setMessages([]);
    // 离开消息区（卸载）时复位，避免残留 stale 的 currentConversationId
    // （例如右区 members tab 会据此判断是否在频道会话里）。
    return () => {
      setCurrentConversationId(null);
      setMessages([]);
    };
  }, [id, isAssistant, router, setCurrentConversationId, setMessages]);

  // 重定向进行中，不渲染消息壳，避免闪一帧空 IM。
  if (isAssistant) return null;

  return (
    <PageShell
      sidebar={<MessagesSidebar />}
      scrollContainerRef={scrollRef}
      header={id ? <ImConversationHeader /> : undefined}
    >
      {id ? (
        <ImConversationBody id={id} scrollRef={scrollRef} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("emptyHint")}
        </div>
      )}
    </PageShell>
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
