"use client";

import type { MessageUsage } from "@meshbot/types-agent";
import {
  type ArtifactPreviewTarget,
  MessageList as MessageListBase,
  type TimelineMessage,
} from "@meshbot/web-common/session";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { currentUserAtom } from "@/atoms/auth";
import { conversationsAtom } from "@/atoms/im";
import { useRemoteSession } from "@/hooks/remote-session-context";
import { useModelConfigs } from "@/rest/model-config";
import { regenerateMessage, setMessageFeedback } from "@/rest/session";
import { SubagentCard } from "./subagent-card";

/**
 * `TimelineMessage`/`ToolCallView` 原在本文件定义，Task 6 随 `useSessionStream`
 * 迁入 `@meshbot/web-common/session`（hook 唯一数据出口，web-common 侧也要用）。
 * 这里改为 re-export，`@/components/session/message-list` 既有 import 路径不变。
 */
export type {
  TimelineMessage,
  ToolCallView,
} from "@meshbot/web-common/session";

interface MessageListProps {
  messages: TimelineMessage[];
  /** 当前会话 id。供 UserMessageActions 调 regenerate 端点用。 */
  sessionId: string;
  /** 会话是否有 inflight run。重试按钮按这个 disable。 */
  running: boolean;
  /**
   * 用户点重试时，父组件截断 timeline 到该消息（含），实现乐观反馈。
   */
  onRegenerateOptimisticCut: (messageId: string) => void;
  /** 按消息 ID 索引的单次 LLM 调用用量，仅 assistant 消息使用。 */
  usageByMessage?: Record<string, MessageUsage>;
  /** 嵌套模式（子 Agent 卡内）：隐藏头像行/名字/重试/反馈，仅保留内容与工具块。 */
  nested?: boolean;
  /**
   * 只读模式（远程设备历史查看，L2c）：隐藏 AssistantMessageActions /
   * UserMessageActions（重试/反馈/编辑等写操作），保留头像行/名字/工具块。
   * 与 nested 语义正交——nested 是「视觉收窄」，readOnly 是「禁写」。
   */
  readOnly?: boolean;
  /**
   * 确认/取消 im_send_message / drive 分享类 HITL（透传给 ToolCallBlock）。
   * HITL 收敛（Task 8）：调用方统一传 `useSessionStream().confirm`。
   */
  onConfirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  /**
   * 提交 ask_question 型 HITL 的回答（透传给 ToolCallBlock/AskQuestionCard）。
   * HITL 收敛（Task 8）：调用方统一传 `useSessionStream().answer`。
   */
  onAnswer: (
    toolCallId: string,
    answers: { selected: string[]; other?: string }[],
  ) => Promise<void>;
}

/**
 * web-agent 薄容器：把 web-common `MessageList` 接线到本应用的数据源——
 * 当前用户展示名（`currentUserAtom`）、i18n 文案、AssistantMessageActions/
 * UserMessageActions 的 REST 回调（`setMessageFeedback`/`regenerateMessage`）、
 * ToolCallBlock 的 IM 会话目标解析（`conversationsAtom`）/ 产物预览
 * （`previewArtifactAtom` + `useRemoteSession()`）/ dispatch_subagent 渲染插槽
 * （`SubagentCard`）。
 *
 * 这是 Task 8（`tool-call-block.tsx`）与 Task 7（`assistant-message-actions.tsx`/
 * `user-message-actions.tsx`）三个薄容器在 Task 9 的合并——`MessageList` 迁入
 * web-common 后直接渲染 web-common 版 `AssistantMessageActions`/
 * `UserMessageActions`/`ToolCallBlock`/`CompactionRow`，不再经过原来那层
 * app 专属中间组件，三者的接线逻辑收敛进本文件（原三个薄容器文件已删除，
 * 唯一消费方就是本文件）。
 */
export function MessageList({
  messages,
  sessionId,
  running,
  onRegenerateOptimisticCut,
  usageByMessage,
  nested,
  readOnly,
  onConfirm,
  onAnswer,
}: MessageListProps) {
  const t = useTranslations("session");
  const tArtifact = useTranslations("session.artifact");
  const user = useAtomValue(currentUserAtom);
  const userName = user?.displayName ?? user?.email ?? t("youName");
  const assistantName = t("assistantName");
  const conversations = useAtomValue(conversationsAtom);
  const setArtifact = useSetAtom(previewArtifactAtom);
  const remote = useRemoteSession();
  const { data: modelConfigs } = useModelConfigs();

  return (
    <MessageListBase
      messages={messages}
      sessionId={sessionId}
      running={running}
      onRegenerateOptimisticCut={onRegenerateOptimisticCut}
      usageByMessage={usageByMessage}
      nested={nested}
      readOnly={readOnly}
      onConfirm={onConfirm}
      onAnswer={onAnswer}
      userName={userName}
      assistantName={assistantName}
      modelConfigs={modelConfigs}
      onFeedback={setMessageFeedback}
      onRegenerate={regenerateMessage}
      assistantActionsLabels={{
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
      }}
      resolveImTargetName={(conversationId) => {
        const target = conversations.find((c) => c.id === conversationId);
        return (
          target?.name ?? target?.peer?.displayName ?? conversationId ?? "会话"
        );
      }}
      onPreviewArtifact={(target: ArtifactPreviewTarget) => setArtifact(target)}
      artifactRemote={
        remote
          ? { deviceId: remote.remoteDeviceId, sessionId: remote.sessionId }
          : null
      }
      toolCallLabels={{ artifactPresentFailed: tArtifact("presentFailed") }}
      renderSubagentCard={(subTool) => <SubagentCard tool={subTool} />}
      labels={{
        assistantName,
        runErrorPrefix: t("runErrorPrefix"),
        generatingReply: t("generatingReply"),
        reasoningThinking: (seconds) => t("reasoningThinking", { seconds }),
        reasoningThought: (seconds) => t("reasoningThought", { seconds }),
        reasoningProcess: t("reasoningProcess"),
        compactionRowTitle: (count) => t("compaction.rowTitle", { count }),
      }}
    />
  );
}
