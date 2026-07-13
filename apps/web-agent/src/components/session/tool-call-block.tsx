"use client";

import {
  type ArtifactPreviewTarget,
  ToolCallBlock as ToolCallBlockBase,
} from "@meshbot/web-common/session";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { conversationsAtom } from "@/atoms/im";
import { useRemoteSession } from "@/hooks/remote-session-context";
import type { ToolCallView } from "./message-list";
import { SubagentCard } from "./subagent-card";

/**
 * web-agent 薄容器：把 web-common `ToolCallBlock` 接线到本应用的数据源——
 * IM 会话列表（im_send_message 卡片的 targetName 解析）、产物预览 atom +
 * 远程会话上下文（present_file 卡片）、i18n 文案，以及 dispatch_subagent 的
 * 渲染插槽（见 web-common 侧 `renderSubagentCard` JSDoc：SubagentCard 内部
 * 消费 `useSessionStream` + 递归 `MessageList`，两者均未随本批迁入
 * web-common，留在本应用整卡渲染）。onConfirm/onAnswer 由上游
 * （message-list.tsx → assistant-conversation-body/assistant-dock/
 * subagent-card 的 `useSessionStream().confirm/answer`）直接透传，本组件
 * 不再感知 local/remote 分支。
 */
export function ToolCallBlock({
  tool,
  onConfirm,
  onAnswer,
}: {
  tool: ToolCallView;
  onConfirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  onAnswer: (
    toolCallId: string,
    answers: { selected: string[]; other?: string }[],
  ) => Promise<void>;
}) {
  const t = useTranslations("session.artifact");
  const conversations = useAtomValue(conversationsAtom);
  const setArtifact = useSetAtom(previewArtifactAtom);
  const remote = useRemoteSession();

  return (
    <ToolCallBlockBase
      tool={tool}
      onConfirm={onConfirm}
      onAnswer={onAnswer}
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
      labels={{ artifactPresentFailed: t("presentFailed") }}
      renderSubagentCard={(subTool) => <SubagentCard tool={subTool} />}
    />
  );
}
