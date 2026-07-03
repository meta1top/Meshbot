"use client";

import type {
  ConversationSummary,
  GlobalEventEnvelope,
  ImConversationReadEvent,
  ImMessage,
  PresenceState,
} from "@meshbot/types";
import { AUTH_WS_EVENTS, IM_WS_EVENTS } from "@meshbot/types";
import {
  QUICK_ASSISTANT_EVENTS,
  type QuickAssistantRenamedEvent,
  SCHEDULE_EVENTS,
  type ScheduleFiredEvent,
} from "@meshbot/types-agent";
import { clearAccessToken } from "@meshbot/web-common";
import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { quickAssistantNameAtom } from "@/atoms/assistant-panel";
import {
  applyIncomingMessageAtom,
  markConversationReadAtom,
  removeConversationAtom,
  setPresenceAtom,
  upsertConversationAtom,
} from "@/atoms/im";
import { addScheduleActivityAtom } from "@/atoms/schedule-activity";
import { getEventsSocket } from "@/lib/events-socket";

/** 全局事件分发表：按信封 type 调对应 handler。纯函数，便于单测。 */
export interface GlobalEventHandlers {
  onMessage: (p: ImMessage) => void;
  onPresence: (p: PresenceState) => void;
  onConversationCreated: (p: ConversationSummary) => void;
  onConversationRemoved: (p: { conversationId: string }) => void;
  onConversationRead: (p: ImConversationReadEvent) => void;
  onScheduleFired: (p: ScheduleFiredEvent) => void;
  onQuickAssistantRenamed: (p: QuickAssistantRenamedEvent) => void;
  onReauthRequired: (p: { cloudUserId: string }) => void;
}

export function dispatchGlobalEvent(
  env: GlobalEventEnvelope,
  h: GlobalEventHandlers,
): void {
  switch (env.type) {
    case IM_WS_EVENTS.message:
      h.onMessage(env.payload as ImMessage);
      break;
    case IM_WS_EVENTS.presence:
      h.onPresence(env.payload as PresenceState);
      break;
    case IM_WS_EVENTS.conversationCreated:
      h.onConversationCreated(env.payload as ConversationSummary);
      break;
    case IM_WS_EVENTS.conversationRemoved:
      h.onConversationRemoved(env.payload as { conversationId: string });
      break;
    case IM_WS_EVENTS.conversationRead:
      h.onConversationRead(env.payload as ImConversationReadEvent);
      break;
    case SCHEDULE_EVENTS.fired:
      h.onScheduleFired(env.payload as ScheduleFiredEvent);
      break;
    case QUICK_ASSISTANT_EVENTS.renamed:
      h.onQuickAssistantRenamed(env.payload as QuickAssistantRenamedEvent);
      break;
    case AUTH_WS_EVENTS.reauthRequired:
      h.onReauthRequired(env.payload as { cloudUserId: string });
      break;
    default:
      break;
  }
}

/**
 * 云端凭据吊销 → 清本地 token（全量登出）+ 硬跳 /login。
 * 用 `window.location.href` 而非 router.replace：硬跳顺带清空内存中的
 * react-query 缓存 / jotai atom 状态，避免过期数据残留，简单可靠。
 */
function handleReauthRequired(): void {
  clearAccessToken();
  window.location.href = "/login";
}

/**
 * Shell 级全局事件总线订阅（常驻，挂在 (shell)/layout）。单一 `event` 信封 → 按 type
 * 分发到 atom：IM 消息/在线/会话增删/已读、定时任务触发。任何页面都实时。
 */
export function useGlobalEvents(): void {
  const applyIncomingMessage = useSetAtom(applyIncomingMessageAtom);
  const setPresence = useSetAtom(setPresenceAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);
  const removeConversation = useSetAtom(removeConversationAtom);
  const markConversationRead = useSetAtom(markConversationReadAtom);
  const addScheduleActivity = useSetAtom(addScheduleActivityAtom);
  const setQuickAssistantName = useSetAtom(quickAssistantNameAtom);

  useEffect(() => {
    const socket = getEventsSocket();
    const handlers: GlobalEventHandlers = {
      onMessage: (p) => applyIncomingMessage(p),
      onPresence: (p) => setPresence(p),
      onConversationCreated: (p) => upsertConversation(p),
      onConversationRemoved: (p) => removeConversation(p.conversationId),
      onConversationRead: (p) => markConversationRead(p.conversationId),
      onScheduleFired: (p) => addScheduleActivity(p.sessionId),
      onQuickAssistantRenamed: (p) => setQuickAssistantName(p.name),
      onReauthRequired: () => handleReauthRequired(),
    };
    const onEvent = (env: GlobalEventEnvelope) =>
      dispatchGlobalEvent(env, handlers);
    socket.on("event", onEvent);
    return () => {
      socket.off("event", onEvent);
    };
  }, [
    applyIncomingMessage,
    setPresence,
    upsertConversation,
    removeConversation,
    markConversationRead,
    addScheduleActivity,
    setQuickAssistantName,
  ]);
}
