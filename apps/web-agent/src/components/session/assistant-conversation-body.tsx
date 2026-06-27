"use client";

import { useAtomValue } from "jotai";
import { ArrowDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { sessionTotalsAtom, usageByMessageAtom } from "@/atoms/session-usage";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { CompactionBanner } from "@/components/common/compaction-banner";
import { MessageSkeleton } from "@/components/im/message-skeleton";
import { MessageList } from "@/components/session/message-list";
import { PendingList } from "@/components/session/pending-list";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";
import { useSessionStream } from "@/hooks/use-session-stream";
import { toI18nList } from "@/lib/i18n-list";
import { useModelConfigs } from "@/rest/model-config";
import { deletePendingMessage } from "@/rest/session";

interface AssistantConversationBodyProps {
  /** 当前会话 ID，由 page 传入（渲染时必有）。 */
  id: string;
  /** 共享滚动容器 ref，由 AppShellLayout/page 传入。 */
  scrollRef: RefObject<HTMLDivElement | null>;
}

/** 助手会话主体：stream、消息列表、pending、粘底输入。不含外壳/header。 */
export function AssistantConversationBody({
  id,
  scrollRef,
}: AssistantConversationBodyProps) {
  const t = useTranslations("session");
  const tHome = useTranslations("home");
  const [draft, setDraft] = useState("");
  const chatInputRef = useRef<ChatInputHandle>(null);

  // 输入框 placeholder：挂载后从同一组文案随机选一条（与首页一致，避免单调）
  // sync-locales 把数组 flatten 成 numeric-key 对象，toI18nList 兜底还原列表
  const placeholders = toI18nList(tHome.raw("inputPlaceholders"));
  const [phIdx, setPhIdx] = useState(0);
  useEffect(() => {
    if (placeholders.length > 1) {
      setPhIdx(Math.floor(Math.random() * placeholders.length));
    }
  }, [placeholders.length]);
  const inputPlaceholder = placeholders[phIdx];
  const topSentinelRef = useRef<HTMLDivElement>(null);

  const usageByMessage = useAtomValue(usageByMessageAtom);
  const sessionTotals = useAtomValue(sessionTotalsAtom);
  const { data: modelConfigs } = useModelConfigs();
  const enabledModel = modelConfigs?.find((c) => c.enabled);
  // contextWindow 由后端在配置入库时按 MODEL_SPECS 解析后固化（用户可覆盖），前端直接读
  const contextWindow = enabledModel?.contextWindow ?? 128_000;

  const prefix = useLlmusePrefix();
  const stream = useSessionStream(id, scrollRef);

  const timelineMessages = useMemo(
    () => stream.messages.filter((m) => !m.pending),
    [stream.messages],
  );
  const queuedMessages = useMemo(
    () => stream.messages.filter((m) => m.pending),
    [stream.messages],
  );

  const { stickToBottom, scrollToBottom } = useChatScroll({
    scrollContainerRef: scrollRef,
    topSentinelRef,
    messages: timelineMessages,
    hasMore: stream.hasMoreHistory,
    onLoadMore: () => void stream.loadMoreHistory(),
  });

  /**
   * 删除一条 pending 消息。
   * - 200：本地从 messages 移除
   * - 404：消息已不存在，本地也移除（兜底）
   * - 409：runner 已开始处理；不动本地，依赖 onHuman 自然推动状态收敛
   * - 其他错误：alert 提示
   */
  const handleDeletePending = async (pendingId: string) => {
    try {
      await deletePendingMessage(id, pendingId);
      stream.apply((prev) => prev.filter((m) => m.id !== pendingId));
    } catch (err) {
      const status =
        err instanceof Error &&
        "response" in err &&
        typeof (err as { response?: { status?: number } }).response?.status ===
          "number"
          ? (err as { response: { status: number } }).response.status
          : undefined;
      if (status === 404) {
        stream.apply((prev) => prev.filter((m) => m.id !== pendingId));
      } else if (status === 409) {
        window.alert(t("cannotDeleteWhileProcessing"));
      } else {
        console.error("删除 pending 失败", err);
        window.alert(t("networkError"));
      }
    }
  };

  /**
   * 编辑 = 删 + 把内容回填输入框 + focus。
   * 若输入框已有非空 draft，confirm 后才覆盖。
   */
  const handleEditPending = async (pendingId: string) => {
    if (draft.trim() && !window.confirm(t("confirmOverwriteDraft"))) return;
    try {
      const { content } = await deletePendingMessage(id, pendingId);
      stream.apply((prev) => prev.filter((m) => m.id !== pendingId));
      setDraft(content);
      // 把 content 显式传给 focus —— setDraft 是异步的，focus 同一 tick 调用时
      // 闭包里的 value 仍是旧值。withText 让组件直接同步 DOM 到末尾。
      chatInputRef.current?.focus(content);
    } catch (err) {
      const status =
        err instanceof Error &&
        "response" in err &&
        typeof (err as { response?: { status?: number } }).response?.status ===
          "number"
          ? (err as { response: { status: number } }).response.status
          : undefined;
      if (status === 404) {
        stream.apply((prev) => prev.filter((m) => m.id !== pendingId));
      } else if (status === 409) {
        window.alert(t("cannotEditWhileProcessing"));
      } else {
        console.error("编辑 pending 失败", err);
        window.alert(t("networkError"));
      }
    }
  };

  return (
    <>
      <div className="flex w-full flex-1 flex-col">
        {stream.historyLoading ? (
          <MessageSkeleton />
        ) : (
          <>
            {stream.hasMoreHistory && (
              <div
                ref={topSentinelRef}
                className="flex justify-center py-2 text-xs text-muted-foreground/60"
              />
            )}
            <CompactionBanner
              visible={!!stream.compacting}
              reason={stream.compacting ?? undefined}
            />
            <MessageList
              messages={timelineMessages}
              sessionId={id}
              running={stream.running}
              onRegenerateOptimisticCut={(messageId) => {
                // 截断到该消息（含），并清掉它的 failed 标记：
                // 重生成就是「这条 user 即将重跑」，旧的 failed 已陈旧；
                // 若新一轮再失败，onError 会重新打 failed。
                stream.apply((prev) => {
                  const idx = prev.findIndex((m) => m.id === messageId);
                  if (idx < 0) return prev;
                  return prev
                    .slice(0, idx + 1)
                    .map((m) =>
                      m.id === messageId && m.failed
                        ? { ...m, failed: false }
                        : m,
                    );
                });
              }}
              usageByMessage={usageByMessage}
            />
          </>
        )}
      </div>
      {/*
        sticky 输入区：bottom-4 距底 16px；上方放绝对定位的渐变遮罩做软淡出。
        下方那 16px 缝隙由独立 bottom-bar 覆盖，避免滚动文字从缝隙钻出。
      */}
      <div className="sticky bottom-4 mt-auto w-full bg-background">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-b from-transparent to-background"
        />
        {/* 底部缝隙遮挡：与 sticky 容器的 bottom-4 一致，覆盖输入框与窗口底之间的间隙 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -bottom-4 h-4 bg-background"
        />
        {/* 滚到底按钮：仅在用户离开底部时显示；点击恢复 stickToBottom + 立即平滑滚到底 */}
        {!stickToBottom && (
          <button
            type="button"
            aria-label={t("scrollToBottom")}
            className="absolute right-2 -top-12 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-muted"
            onClick={scrollToBottom}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <PendingList
              messages={queuedMessages}
              onDelete={handleDeletePending}
              onEdit={handleEditPending}
            />
          </div>
        )}
        <ChatInput
          ref={chatInputRef}
          value={draft}
          onChange={setDraft}
          onSend={(t) => stream.send(prefix(t))}
          onInterrupt={stream.interrupt}
          isLoading={stream.running}
          placeholder={inputPlaceholder}
          tokenUsage={{
            // 「下次请求估算 / ctx 上限」—— 用 lastInputTokens 作为代理：
            // 这是上一轮 LLM 真实计数，下一轮 input 约等于这个（用户新输入
            // 通常远小于历史）。比 sum(input+output) 量纲更对。
            current: sessionTotals.lastInputTokens,
            max: contextWindow,
            breakdown: {
              inputTokens: sessionTotals.inputTokens,
              outputTokens: sessionTotals.outputTokens,
              cacheReadTokens: sessionTotals.cacheReadTokens,
              reasoningTokens: sessionTotals.reasoningTokens,
              callCount: sessionTotals.callCount,
              cumulativeTokens: sessionTotals.totalTokens,
            },
          }}
        />
      </div>
    </>
  );
}
