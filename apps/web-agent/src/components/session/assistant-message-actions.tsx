"use client";

import type { MessageUsage } from "@meshbot/types-agent";
import {
  AssistantMessageActions as AssistantMessageActionsBase,
  type AssistantMessageActionsLabels,
} from "@meshbot/web-common/session";
import { useTranslations } from "next-intl";
import { useModelConfigs } from "@/rest/model-config";
import { setMessageFeedback } from "@/rest/session";

interface Props {
  sessionId: string;
  messageId: string;
  content: string;
  /** 该条 assistant 的单次 LLM 用量；无则不显示用量图标。 */
  usage?: MessageUsage;
  /** 初始反馈态（来自 history）。 */
  feedback?: "up" | "down" | null;
}

/**
 * assistant 气泡下方操作行容器：atoms/REST 数据装配 + labels 注入，
 * 渲染委托 web-common AssistantMessageActions。
 */
export function AssistantMessageActions({
  sessionId,
  messageId,
  content,
  usage,
  feedback,
}: Props) {
  const t = useTranslations("session");
  const { data: modelConfigs } = useModelConfigs();

  const labels: AssistantMessageActionsLabels = {
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
  };

  return (
    <AssistantMessageActionsBase
      sessionId={sessionId}
      messageId={messageId}
      content={content}
      usage={usage}
      feedback={feedback}
      modelConfigs={modelConfigs}
      onFeedback={setMessageFeedback}
      labels={labels}
    />
  );
}
