"use client";

import { stripLlmuse } from "@meshbot/types-agent";
import { useAtomValue } from "jotai";
import { ArrowDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  sessionTotalsFamily,
  usageByMessageFamily,
} from "@/atoms/session-usage";
import { sessionsAtom } from "@/atoms/sessions";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { CompactionBanner } from "@/components/common/compaction-banner";
import { ComposerActions } from "@/components/common/composer-actions";
import { ModelSelect } from "@/components/common/model-select";
import { MessageSkeleton } from "@/components/im/message-skeleton";
import { MessageList } from "@/components/session/message-list";
import { PendingList } from "@/components/session/pending-list";
import { RemoteSessionProvider } from "@/hooks/remote-session-context";
import { useAutoOpenArtifact } from "@/hooks/use-auto-open-artifact";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";
import { useSessionStream } from "@/hooks/use-session-stream";
import { toI18nList } from "@/lib/i18n-list";
import { useModelConfigs } from "@/rest/model-config";
import { deletePendingMessage, patchSession } from "@/rest/session";

interface AssistantConversationBodyProps {
  /** 当前会话 ID，由 page 传入（渲染时必有）。远程会话时是 B 上的会话 id。 */
  id: string;
  /** 共享滚动容器 ref，由 PageShell/page 传入。 */
  scrollRef: RefObject<HTMLDivElement | null>;
  /**
   * L3：非空表示这是远程设备（B）上的会话——`useSessionStream` 走远程分支
   * （历史/send/interrupt 隧道到 B），MessageList 传 `readOnly` 隐藏反馈/重试/
   * 编辑等写操作（这些走本地端点，对远程会话的 id 无意义，且 L3 未覆盖）；
   * 输入框本身保持可用，走 `startRemoteRun`。
   */
  remoteDeviceId?: string | null;
  /** 远程会话首轮由起手台 create 发起时的初始 streamId，见 useSessionStream 注释。 */
  remoteInitialStreamId?: string | null;
}

/** 助手会话主体：stream、消息列表、pending、粘底输入。不含外壳/header。 */
export function AssistantConversationBody({
  id,
  scrollRef,
  remoteDeviceId = null,
  remoteInitialStreamId = null,
}: AssistantConversationBodyProps) {
  const t = useTranslations("session");
  const tHome = useTranslations("home");
  const tRemote = useTranslations("assistantSidebar");
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

  const usageByMessage = useAtomValue(usageByMessageFamily(id));
  const sessionTotals = useAtomValue(sessionTotalsFamily(id));
  const { data: modelConfigs } = useModelConfigs();
  const enabledModel = modelConfigs?.find((c) => c.enabled);
  // 会话级模型：初值取会话摘要里的 modelConfigId，切换 PATCH 后本地覆盖，
  // 下一条消息由后端 runner 读列生效。
  const allSessions = useAtomValue(sessionsAtom);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const sessionModelId =
    modelOverride ??
    allSessions.find((s) => s.id === id)?.modelConfigId ??
    null;
  const handleModelChange = async (mid: string) => {
    try {
      await patchSession(id, { modelConfigId: mid });
      setModelOverride(mid);
    } catch (err) {
      console.error("切换模型失败", err);
    }
  };
  // contextWindow 由后端在配置入库时按 MODEL_SPECS 解析后固化（用户可覆盖），前端直接读
  const contextWindow = enabledModel?.contextWindow ?? 128_000;

  const prefix = useLlmusePrefix();
  const stream = useSessionStream(
    id,
    scrollRef,
    remoteDeviceId,
    remoteInitialStreamId,
  );

  const timelineMessages = useMemo(
    () => stream.messages.filter((m) => !m.pending),
    [stream.messages],
  );
  const queuedMessages = useMemo(
    () => stream.messages.filter((m) => m.pending),
    [stream.messages],
  );

  // agent 产出 present_file 后自动打开右侧预览（多个产物弹第一个，正在看预览时不打扰）。
  useAutoOpenArtifact(timelineMessages, stream.running);

  const { stickToBottom, scrollToBottom, topSentinelRef } = useChatScroll({
    scrollContainerRef: scrollRef,
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
      const clean = stripLlmuse(content);
      setDraft(clean);
      // 把 clean 显式传给 focus —— setDraft 是异步的，focus 同一 tick 调用时
      // 闭包里的 value 仍是旧值。withText 让组件直接同步 DOM 到末尾。
      chatInputRef.current?.focus(clean);
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

  // 提取成变量避免 remote/本地两个渲染分支各写一遍——远程会话下外面套
  // RemoteSessionProvider（深层 HITL 卡片经 useRemoteSession 拿 confirm/answer
  // 走远程端点），本地会话直接渲染，不包 Provider（useRemoteSession 返回 null）。
  const messageListNode = (
    <MessageList
      messages={timelineMessages}
      sessionId={id}
      running={stream.running}
      readOnly={!!remoteDeviceId}
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
              m.id === messageId && m.failed ? { ...m, failed: false } : m,
            );
        });
      }}
      usageByMessage={usageByMessage}
    />
  );

  return (
    <>
      <div className="flex w-full flex-1 flex-col">
        {stream.historyLoading ? (
          <MessageSkeleton />
        ) : stream.historyError ? (
          // 目前仅 remote 分支会置位（跨设备 relay 更易超时/离线）；本地
          // 分支历史拉取失败不置位，沿用原行为（历史留空，不额外提示）。
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {tRemote("remoteLoadFailed")}
          </div>
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
            {remoteDeviceId ? (
              <RemoteSessionProvider
                remoteDeviceId={remoteDeviceId}
                sessionId={id}
                getStreamId={stream.getStreamId}
              >
                {messageListNode}
              </RemoteSessionProvider>
            ) : (
              messageListNode
            )}
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
          topLeading={
            <ModelSelect value={sessionModelId} onChange={handleModelChange} />
          }
          leadingActions={<ComposerActions />}
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
