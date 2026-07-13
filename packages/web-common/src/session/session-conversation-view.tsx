"use client";

import type { MessageUsage } from "@meshbot/types-agent";
import { ArrowDown } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { ArtifactPreviewTarget } from "./artifact-file-card";
import type { AssistantMessageActionsLabels } from "./assistant-message-actions";
import {
  CompactionBanner,
  type CompactionBannerLabels,
} from "./compaction-banner";
import { MessageList, type MessageListLabels } from "./message-list";
import { MessageSkeleton } from "./message-skeleton";
import type { ModelConfigLike } from "./model-name";
import { PendingList, type PendingListLabels } from "./pending-list";
import type { TimelineMessage, ToolCallView } from "./timeline";
import type { ToolCallBlockLabels } from "./tool-call-block";

export interface SessionConversationViewLabels {
  /** 滚到底按钮 aria-label。 */
  scrollToBottom: string;
  /** 历史加载失败提示文案（目前仅 remote 分支会置位）。 */
  remoteLoadFailed: string;
  /** 转发给 CompactionBanner。 */
  compaction: CompactionBannerLabels;
  /** 转发给 MessageList 自身渲染用的文案。 */
  messageList: MessageListLabels;
  /** 转发给 ToolCallBlock（经 MessageList 透传）。 */
  toolCall: ToolCallBlockLabels;
  /** 转发给 PendingList。 */
  pendingList: PendingListLabels;
  /** 转发给 AssistantMessageActions（经 MessageList 透传）；`readOnly` 时可不传。 */
  assistantActions?: AssistantMessageActionsLabels;
}

export interface SessionConversationViewProps {
  /** 历史仍在加载：渲染 MessageSkeleton 占位。 */
  historyLoading: boolean;
  /** 历史拉取失败（目前仅 remote 分支会置位）：渲染错误态文案，不再渲染消息列表。 */
  historyError: boolean;
  hasMoreHistory: boolean;
  /** 顶部哨兵 ref（调用方的 IntersectionObserver 挂在这个节点上，用于翻页加载更多历史）。 */
  topSentinelRef: Ref<HTMLDivElement>;
  /** 会话压缩中提示条：非空即 visible=true，值决定文案分支。 */
  compacting?: "threshold" | "ctx-exceeded" | null;
  /** 已落定的时间线消息（不含 pending）。 */
  timelineMessages: TimelineMessage[];
  /** 待处理消息（pending 区，渲染在输入框上方）。 */
  queuedMessages: TimelineMessage[];
  sessionId: string;
  running: boolean;
  onRegenerateOptimisticCut: (messageId: string) => void;
  usageByMessage?: Record<string, MessageUsage>;
  /**
   * 只读模式（远程设备历史查看，L2c）：隐藏 AssistantMessageActions /
   * UserMessageActions（重试/反馈/编辑等写操作），保留头像行/名字/工具块。
   */
  readOnly?: boolean;
  onConfirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  onAnswer: (
    toolCallId: string,
    answers: { selected: string[]; other?: string }[],
  ) => Promise<void>;
  userName?: string;
  assistantName?: string;
  modelConfigs?: ModelConfigLike[];
  onFeedback?: (
    sessionId: string,
    messageId: string,
    value: "up" | "down" | null,
  ) => Promise<unknown>;
  onRegenerate?: (sessionId: string, messageId: string) => Promise<unknown>;
  onActionsError?: (err: unknown) => void;
  resolveImTargetName: (conversationId: string | undefined) => string;
  onPreviewArtifact: (target: ArtifactPreviewTarget) => void;
  artifactRemote?: { deviceId: string; sessionId: string } | null;
  renderSubagentCard: (tool: ToolCallView) => ReactNode;
  /** 是否停留在底部（false 时显示滚到底按钮）。 */
  stickToBottom: boolean;
  onScrollToBottom: () => void;
  /** pending 消息删除/编辑回调，透传给 PendingList。 */
  onDeletePending?: (id: string) => Promise<void>;
  onEditPending?: (id: string) => Promise<void>;
  /**
   * 输入区渲染插槽：`ChatInput` 本批不迁（session 专属深功能多，见 Task 9
   * brief）——调用方（web-agent 注入 `ChatInput`）负责组装草稿/发送/中断/
   * token 用量/模型选择器等。插槽渲染在 sticky 底栏内、PendingList 之下。
   */
  renderInput: () => ReactNode;
  labels: SessionConversationViewLabels;
}

/**
 * 助手会话主体的纯装配视图：历史加载态/错误态、顶部哨兵、压缩提示条、
 * 消息时间线、粘底 pending 区 + 滚到底按钮 + 输入区插槽。
 *
 * 从 `apps/web-agent/src/components/session/assistant-conversation-body.tsx`
 * 拆分迁入（Task 9 骨干批）——「渲染结构」进本组件，「数据装配」（`useSessionStream`/
 * `useChatScroll`/`RemoteSessionProvider`/transport 构造/模型选择等 hook 调用）
 * 留在 web-agent 侧薄容器。`RemoteSessionProvider` 不在本组件内部：远程会话时
 * 调用方在外层包一层（本组件的 `useRemoteSession()` 深层消费方——
 * `renderSubagentCard` 注入的 `SubagentCard`——仍能拿到正确的 context，
 * 因为 Provider 包裹的是整棵调用方渲染树，不是某个内部节点）。
 *
 * 渲染结构与原 `AssistantConversationBody` 逐行等价搬运。
 */
export function SessionConversationView({
  historyLoading,
  historyError,
  hasMoreHistory,
  topSentinelRef,
  compacting,
  timelineMessages,
  queuedMessages,
  sessionId,
  running,
  onRegenerateOptimisticCut,
  usageByMessage,
  readOnly,
  onConfirm,
  onAnswer,
  userName,
  assistantName,
  modelConfigs,
  onFeedback,
  onRegenerate,
  onActionsError,
  resolveImTargetName,
  onPreviewArtifact,
  artifactRemote,
  renderSubagentCard,
  stickToBottom,
  onScrollToBottom,
  onDeletePending,
  onEditPending,
  renderInput,
  labels,
}: SessionConversationViewProps) {
  const messageListNode = (
    <MessageList
      messages={timelineMessages}
      sessionId={sessionId}
      running={running}
      readOnly={readOnly}
      onRegenerateOptimisticCut={onRegenerateOptimisticCut}
      usageByMessage={usageByMessage}
      onConfirm={onConfirm}
      onAnswer={onAnswer}
      userName={userName}
      assistantName={assistantName}
      modelConfigs={modelConfigs}
      onFeedback={onFeedback}
      onRegenerate={onRegenerate}
      onActionsError={onActionsError}
      assistantActionsLabels={labels.assistantActions}
      resolveImTargetName={resolveImTargetName}
      onPreviewArtifact={onPreviewArtifact}
      artifactRemote={artifactRemote}
      renderSubagentCard={renderSubagentCard}
      toolCallLabels={labels.toolCall}
      labels={labels.messageList}
    />
  );

  return (
    <>
      <div className="flex w-full flex-1 flex-col">
        {historyLoading ? (
          <MessageSkeleton />
        ) : historyError ? (
          // 目前仅 remote 分支会置位（跨设备 relay 更易超时/离线）；本地
          // 分支历史拉取失败不置位，沿用原行为（历史留空，不额外提示）。
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {labels.remoteLoadFailed}
          </div>
        ) : (
          <>
            {hasMoreHistory && (
              <div
                ref={topSentinelRef}
                className="flex justify-center py-2 text-xs text-muted-foreground/60"
              />
            )}
            <CompactionBanner
              visible={!!compacting}
              reason={compacting ?? undefined}
              labels={labels.compaction}
            />
            {messageListNode}
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
            aria-label={labels.scrollToBottom}
            className="absolute right-2 -top-12 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-muted"
            onClick={onScrollToBottom}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <PendingList
              messages={queuedMessages}
              onDelete={onDeletePending}
              onEdit={onEditPending}
              labels={labels.pendingList}
            />
          </div>
        )}
        {renderInput()}
      </div>
    </>
  );
}
