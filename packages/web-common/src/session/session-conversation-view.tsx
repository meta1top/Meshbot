"use client";

import type { MessageUsage } from "@meshbot/types-agent";
import { ArrowDown } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { ArtifactPreviewTarget } from "./artifact-file-card";
import type { AssistantMessageActionsLabels } from "./assistant-message-actions";
import { MessageList, type MessageListLabels } from "./message-list";
import { MessageSkeleton } from "./message-skeleton";
import type { ModelConfigLike } from "./model-name";
import { PendingList, type PendingListLabels } from "./pending-list";
import {
  deriveStatusLinePhase,
  StatusLine,
  type StatusLineLabels,
} from "./status-line";
import type { TimelineMessage, ToolCallView } from "./timeline";
import type { ToolCallBlockLabels } from "./tool-call-block";

export interface SessionConversationViewLabels {
  /** 滚到底按钮 aria-label。 */
  scrollToBottom: string;
  /** 历史加载失败提示文案（目前仅 remote 分支会置位）。 */
  remoteLoadFailed: string;
  /** 转发给 MessageList 自身渲染用的文案。 */
  messageList: MessageListLabels;
  /**
   * 转发给消息流末尾常驻状态行（StatusLine）的阶段文案。可选——省略时
   * 本组件不渲染 StatusLine（渐进接入：调用方尚未补齐 i18n 文案前不展示，
   * 而不是打印未翻译的兜底英文/占位符）。web-agent/web-main 侧接线补文案
   * 后传入即可点亮该行，见 `deriveStatusLinePhase` 的阶段派生逻辑。
   */
  statusLine?: StatusLineLabels;
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
  /**
   * 会话压缩中：非空即压缩进行中。顶部 banner 已删除（长对话滚在底部时永远
   * 看不到），改由末尾 StatusLine 显「压缩中」+ 完成后系统事件行接管——本字段
   * 只喂给 `deriveStatusLinePhase`（决定 StatusLine 阶段文案），不再驱动任何
   * 独立的 banner 渲染。
   */
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
 * 助手会话主体的纯装配视图：历史加载态/错误态、顶部哨兵、消息时间线（居中
 * 系统事件行随普通消息一起渲染，见 MessageList）、末尾常驻 StatusLine、粘底
 * pending 区 + 滚到底按钮 + 输入区插槽。
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
  // 末尾常驻状态行的阶段：compacting > 工具运行中 > 思考中 > 流式产出中 >
  // 兜底思考中；running 与 compacting 均为假时 null（不渲染）。派生逻辑见
  // status-line.tsx 的 deriveStatusLinePhase（单测覆盖优先级五态）。
  const statusLinePhase = deriveStatusLinePhase({
    running,
    compacting,
    messages: timelineMessages,
  });

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
            {messageListNode}
            {labels.statusLine && (
              // -mt-4 抵消 messageListNode 尾部 pb-6 的过大留白（状态行是消息流
              // 延续，应紧贴最后一条消息）；pb-6 给输入区留足呼吸，避免贴住底部
              // （pb-2 实测仍偏近，用户反馈"距离底部还是有点近"后加大到 pb-6）。
              <div className="-mt-4 pb-6">
                <StatusLine
                  phase={statusLinePhase}
                  labels={labels.statusLine}
                />
              </div>
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
