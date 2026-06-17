"use client";

import { latestAssistantCandidate } from "@meshbot/web-common";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import { ChatInput } from "@/components/common/chat-input";
import { AgentToggle } from "@/components/im/agent-toggle";
import { MessageList } from "@/components/session/message-list";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useSessionStream } from "@/hooks/use-session-stream";
import { useAgentSession, useSetAgentEnabled } from "@/rest/im-agent";

/**
 * IM 伴生 Agent 侧栏：复用助手聊天的流式渲染，指向该会话的伴生 sessionId（Plan 3a）。
 * 展示 Agent 候选回复 / 执行过程，用户可在此继续对话精修；
 * 「发送到会话」取最新候选文本回填 IM 主输入框（左栏），由用户编辑后一键发出。
 * 「Agent 建议」开关切换该会话的伴生触发（默认开）。
 */
export function ImCompanionPanel({
  conversationId,
  onUseCandidate,
}: {
  conversationId: string;
  onUseCandidate: (text: string) => void;
}) {
  const t = useTranslations("messages");
  const { data: agentSession } = useAgentSession(conversationId);
  const toggleMutation = useSetAgentEnabled(conversationId);
  const sessionId = agentSession?.sessionId ?? null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  const stream = useSessionStream(sessionId, scrollRef);
  const timelineMessages = useMemo(
    () => stream.messages.filter((m) => !m.pending),
    [stream.messages],
  );
  useChatScroll({
    scrollContainerRef: scrollRef,
    bottomRef,
    topSentinelRef,
    messages: timelineMessages,
    hasMore: stream.hasMoreHistory,
    onLoadMore: () => void stream.loadMoreHistory(),
  });

  const candidate = latestAssistantCandidate(stream.messages);
  // 乐观：开关本地态 = mutation variables 优先（点击后立即反映），否则后端值
  const enabled =
    toggleMutation.variables ?? agentSession?.agentEnabled ?? true;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">{t("agentPanelTitle")}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("agentSuggestion")}
          </span>
          <AgentToggle
            enabled={enabled}
            disabled={toggleMutation.isPending || !agentSession}
            onToggle={(next) => toggleMutation.mutate(next)}
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3"
      >
        {stream.hasMoreHistory && <div ref={topSentinelRef} className="py-1" />}
        {timelineMessages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {enabled ? t("agentEmptyHint") : t("agentDisabledHint")}
          </div>
        ) : (
          <MessageList
            messages={timelineMessages}
            sessionId={sessionId ?? ""}
            running={stream.running}
            onRegenerateOptimisticCut={() => {}}
          />
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-2">
        <button
          type="button"
          disabled={!candidate}
          onClick={() => candidate && onUseCandidate(candidate)}
          className="mb-2 w-full rounded-md bg-(--shell-accent) px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          title={candidate ? undefined : t("agentNoCandidate")}
        >
          {t("agentSendToConversation")}
        </button>
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={(msg) => {
            void stream.send(msg);
            setDraft("");
          }}
          isLoading={stream.running}
          placeholder={t("agentInputPlaceholder")}
        />
      </div>
    </div>
  );
}
