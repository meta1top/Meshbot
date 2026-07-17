"use client";

import type {
  ArtifactPreviewTarget,
  SessionTransport,
} from "@meshbot/web-common/session";
import {
  MessageList as MessageListBase,
  type TimelineMessage,
  type ToolCallView,
} from "@meshbot/web-common/session";
import { useTranslations } from "next-intl";
import { RemoteSubagentCard } from "./remote-subagent-card";

interface RemoteMessageListProps {
  messages: TimelineMessage[];
  sessionId: string;
  running: boolean;
  onConfirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  onAnswer: (
    toolCallId: string,
    answers: { selected: string[]; other?: string }[],
  ) => Promise<void>;
  /** 该消息流所在的远程设备（嵌套子会话与父会话同设备）。 */
  deviceId: string;
  /** 与调用方（`RemoteSubagentCard`）同一个 transport 实例，透传给本组件
   * 渲染的嵌套子代理卡——多播 `subscribe()` 要求同一条 streamId 的父子会话
   * 复用同一 transport 实例才能都收到帧（见 `RemoteSubagentCard` 类文档）。 */
  transport: SessionTransport;
  /** 本消息流当前有效的 streamId（调用方 `sub.getStreamId()`），透传给嵌套
   * 子代理卡作为其 `remoteInitialStreamId` 初值。 */
  streamId: string | null;
  onPreviewArtifact: (target: ArtifactPreviewTarget) => void;
}

/**
 * web-main 薄容器：把 web-common `MessageList` 接线到本应用的文案/产物预览/
 * 嵌套子代理卡渲染插槽——镜像
 * `apps/web-agent/src/components/session/message-list.tsx` 的角色，仅供
 * **嵌套场景**（`RemoteSubagentCard` 内的子会话消息流）消费；顶层消息流由
 * `SessionConversationView` 内部直接渲染 web-common `MessageList`，不经本文件。
 *
 * `nested` 恒为 true：不渲染 AssistantMessageActions/UserMessageActions
 * （重试/反馈/编辑等写操作，对嵌套子会话无意义），故不需要
 * `modelConfigs`/`onFeedback`/`onRegenerate`/`assistantActionsLabels` 等
 * 仅 `!nested` 时生效的 props。
 */
export function RemoteMessageList({
  messages,
  sessionId,
  running,
  onConfirm,
  onAnswer,
  deviceId,
  transport,
  streamId,
  onPreviewArtifact,
}: RemoteMessageListProps) {
  const t = useTranslations("session");
  const tArtifact = useTranslations("session.artifact");

  return (
    <MessageListBase
      nested
      messages={messages}
      sessionId={sessionId}
      running={running}
      onRegenerateOptimisticCut={() => {}}
      onConfirm={onConfirm}
      onAnswer={onAnswer}
      resolveImTargetName={(conversationId) => conversationId ?? ""}
      onPreviewArtifact={onPreviewArtifact}
      artifactRemote={{ deviceId, sessionId }}
      toolCallLabels={{ artifactPresentFailed: tArtifact("presentFailed") }}
      renderSubagentCard={(subTool: ToolCallView) => (
        <RemoteSubagentCard
          tool={subTool}
          deviceId={deviceId}
          transport={transport}
          streamId={streamId}
          onPreviewArtifact={onPreviewArtifact}
        />
      )}
      labels={{
        assistantName: t("assistantName"),
        runErrorPrefix: t("runErrorPrefix"),
        generatingReply: t("generatingReply"),
        reasoningThinking: (seconds) => t("reasoningThinking", { seconds }),
        reasoningThought: (seconds) => t("reasoningThought", { seconds }),
        reasoningProcess: t("reasoningProcess"),
        compactionRowTitle: (count) => t("compaction.rowTitle", { count }),
        runErrorAgentNotRemotable: t("runErrorAgentNotRemotable"),
      }}
    />
  );
}
