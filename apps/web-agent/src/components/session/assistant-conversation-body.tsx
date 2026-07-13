"use client";

import { stripLlmuse } from "@meshbot/types-agent";
import {
  type ArtifactPreviewTarget,
  SessionConversationView,
} from "@meshbot/web-common/session";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { currentUserAtom } from "@/atoms/auth";
import { conversationsAtom } from "@/atoms/im";
import {
  loadRemoteSessionsAtom,
  remoteSessionsAtom,
} from "@/atoms/remote-sessions";
import {
  sessionTotalsFamily,
  usageByMessageFamily,
} from "@/atoms/session-usage";
import { sessionsAtom } from "@/atoms/sessions";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { ComposerActions } from "@/components/common/composer-actions";
import { ModelSelect } from "@/components/common/model-select";
import { SubagentCard } from "@/components/session/subagent-card";
import { RemoteSessionProvider } from "@/hooks/remote-session-context";
import { useAutoOpenArtifact } from "@/hooks/use-auto-open-artifact";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";
import { useSessionStream } from "@/hooks/use-session-stream";
import { toI18nList } from "@/lib/i18n-list";
import {
  createLocalSessionTransport,
  createRemoteSessionTransport,
} from "@/lib/session-transport";
import { useModelConfigs } from "@/rest/model-config";
import {
  deletePendingMessage,
  regenerateMessage,
  setMessageFeedback,
} from "@/rest/session";

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

/**
 * 助手会话主体：hook 装配/atoms 桥/transport 构造/RemoteSessionProvider，
 * 渲染委托 web-common `SessionConversationView`（Task 9 骨干批拆分）。
 *
 * `RemoteSessionProvider` 保留在本容器（不进 `SessionConversationView`）：
 * 远程会话时包一层 Provider，`SessionConversationView` 内部的
 * `renderSubagentCard` 注入的 `SubagentCard` 仍能通过 `useRemoteSession()`
 * 拿到 remoteDeviceId/sessionId（Provider 包的是整棵渲染树，不只消息列表，
 * 与原实现行为等价——`ChatInput`/`PendingList` 等兄弟节点本就不消费该
 * context）。
 */
export function AssistantConversationBody({
  id,
  scrollRef,
  remoteDeviceId = null,
  remoteInitialStreamId = null,
}: AssistantConversationBodyProps) {
  const t = useTranslations("session");
  const tHome = useTranslations("home");
  const tRemote = useTranslations("assistantSidebar");
  const tChat = useTranslations("chatInput");
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
  // 远程会话的摘要在 remoteSessionsAtom（本地 sessionsAtom 不含对端会话）；
  // 模型配置云端统一下发且本地行 id=云端配置 id，跨设备 id 一致，本地下拉
  // 列表可直接用于远端会话的显示与写入。
  const remoteSessions = useAtomValue(remoteSessionsAtom);
  const loadRemoteSessions = useSetAtom(loadRemoteSessionsAtom);
  // 进入远程会话时强制刷新对端会话列表：modelConfigId 可能已在对端被改
  // （侧栏懒加载的缓存不会自己失效），选择器初值需要新鲜快照。
  useEffect(() => {
    if (remoteDeviceId) void loadRemoteSessions(remoteDeviceId, true);
  }, [remoteDeviceId, loadRemoteSessions]);
  const sessionModelId =
    modelOverride ??
    (remoteDeviceId
      ? (remoteSessions[remoteDeviceId]?.sessions.find((s) => s.id === id)
          ?.modelConfigId ?? null)
      : (allSessions.find((s) => s.id === id)?.modelConfigId ?? null));
  // 经 transport 统一路由：本地 PATCH /api/sessions/:id，远程走 device query 通道
  // （本地 PATCH 对远程会话 id 会 404）——分支判断已下沉到 session-transport.ts。
  const handleModelChange = async (mid: string) => {
    try {
      await stream.patchSessionModel(mid);
      setModelOverride(mid);
    } catch (err) {
      console.error("切换模型失败", err);
    }
  };
  // contextWindow 由后端在配置入库时按 MODEL_SPECS 解析后固化（用户可覆盖），前端直接读
  const contextWindow = enabledModel?.contextWindow ?? 128_000;

  const prefix = useLlmusePrefix();
  // transport 按 remoteDeviceId 二选一：无状态工厂，deviceId 不变时引用稳定，
  // 避免每次渲染重建导致 useSessionStream 内部 effect/callback 误判依赖变化。
  const transport = useMemo(
    () =>
      remoteDeviceId
        ? createRemoteSessionTransport(remoteDeviceId)
        : createLocalSessionTransport(),
    [remoteDeviceId],
  );
  const stream = useSessionStream(
    id,
    scrollRef,
    transport,
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

  // MessageList 内部渲染的数据装配（原先分散在三个 web-agent 薄容器里，
  // 现直接在本容器接线，转发给 SessionConversationView）。
  const user = useAtomValue(currentUserAtom);
  const userName = user?.displayName ?? user?.email ?? t("youName");
  const assistantName = t("assistantName");
  const conversations = useAtomValue(conversationsAtom);
  const setArtifact = useSetAtom(previewArtifactAtom);
  const tArtifact = useTranslations("session.artifact");
  const tCompaction = useTranslations("session.compaction");
  // artifactRemote 直接用本组件已有的 remoteDeviceId/id，不经
  // useRemoteSession() context——本容器渲染在 RemoteSessionProvider 之外
  // （见下方 JSX），此处取 context 值会拿到 null。
  const artifactRemote = remoteDeviceId
    ? { deviceId: remoteDeviceId, sessionId: id }
    : null;

  const view = (
    <SessionConversationView
      historyLoading={stream.historyLoading}
      historyError={!!stream.historyError}
      hasMoreHistory={stream.hasMoreHistory}
      topSentinelRef={topSentinelRef}
      compacting={stream.compacting}
      timelineMessages={timelineMessages}
      queuedMessages={queuedMessages}
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
      onConfirm={stream.confirm}
      onAnswer={stream.answer}
      userName={userName}
      assistantName={assistantName}
      modelConfigs={modelConfigs}
      onFeedback={setMessageFeedback}
      onRegenerate={regenerateMessage}
      resolveImTargetName={(conversationId) => {
        const target = conversations.find((c) => c.id === conversationId);
        return (
          target?.name ?? target?.peer?.displayName ?? conversationId ?? "会话"
        );
      }}
      onPreviewArtifact={(target: ArtifactPreviewTarget) => setArtifact(target)}
      artifactRemote={artifactRemote}
      renderSubagentCard={(subTool) => <SubagentCard tool={subTool} />}
      stickToBottom={stickToBottom}
      onScrollToBottom={scrollToBottom}
      onDeletePending={handleDeletePending}
      onEditPending={handleEditPending}
      renderInput={() => (
        <ChatInput
          ref={chatInputRef}
          value={draft}
          onChange={setDraft}
          onSend={(text) => stream.send(prefix(text))}
          onInterrupt={stream.interrupt}
          isLoading={stream.running}
          placeholder={inputPlaceholder}
          trailingActions={
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
          labels={{
            attachment: tChat("attachment"),
            interrupt: tChat("interrupt"),
            send: tChat("send"),
            usage: {
              nextRequestLabel: t("usage.nextRequestLabel"),
              inputLabel: t("usage.inputLabel"),
              cacheLabel: t("usage.cacheLabel"),
              outputLabel: t("usage.outputLabel"),
              reasoningLabel: t("usage.reasoningLabel"),
              cumulativeLabel: t("usage.cumulativeLabel"),
              callCount: (count) => t("usage.callCount", { count }),
            },
          }}
        />
      )}
      labels={{
        scrollToBottom: t("scrollToBottom"),
        remoteLoadFailed: tRemote("remoteLoadFailed"),
        compaction: {
          bannerThreshold: tCompaction("bannerThreshold"),
          bannerCtxExceeded: tCompaction("bannerCtxExceeded"),
        },
        messageList: {
          assistantName,
          runErrorPrefix: t("runErrorPrefix"),
          generatingReply: t("generatingReply"),
          reasoningThinking: (seconds) => t("reasoningThinking", { seconds }),
          reasoningThought: (seconds) => t("reasoningThought", { seconds }),
          reasoningProcess: t("reasoningProcess"),
          compactionRowTitle: (count) => tCompaction("rowTitle", { count }),
        },
        toolCall: { artifactPresentFailed: tArtifact("presentFailed") },
        pendingList: {
          editPending: t("editPending"),
          deletePending: t("deletePending"),
        },
        assistantActions: {
          copy: t("actions.copy"),
          copied: t("actions.copied"),
          usage: t("actions.usage"),
          like: t("actions.like"),
          dislike: t("actions.dislike"),
          deletedModel: t("usage.deletedModel"),
          inputLabel: t("usage.inputLabel"),
          cacheLabel: t("usage.cacheLabel"),
          outputLabel: t("usage.outputLabel"),
          reasoningLabel: t("usage.reasoningLabel"),
          totalLabel: t("usage.totalLabel"),
        },
      }}
    />
  );

  return remoteDeviceId ? (
    <RemoteSessionProvider remoteDeviceId={remoteDeviceId} sessionId={id}>
      {view}
    </RemoteSessionProvider>
  ) : (
    view
  );
}
