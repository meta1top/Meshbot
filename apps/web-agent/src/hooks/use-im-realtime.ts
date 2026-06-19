"use client";

import type {
  ConversationSummary,
  ImMessage,
  PresenceState,
} from "@meshbot/types";
import { IM_WS_EVENTS } from "@meshbot/types";
import { useSetAtom } from "jotai";
import { useEffect } from "react";
import {
  applyIncomingMessageAtom,
  removeConversationAtom,
  setPresenceAtom,
  upsertConversationAtom,
} from "@/atoms/im";
import { getImSocket } from "@/lib/im-socket";

/**
 * Shell 级 IM 实时订阅（常驻，不绑当前会话）。在 AppShellLayout 调用——任何页面
 * （助手 / 空消息页 / 其它区域）都能实时收到下行消息，从而更新未读 badge / 会话列表 /
 * 在线状态。applyIncomingMessage 内部按 currentConversationId 决定是否追加到当前会话
 * 消息流，所以会话页（ImConversationBody）无需再单独订阅。
 */
export function useImRealtime(): void {
  const applyIncomingMessage = useSetAtom(applyIncomingMessageAtom);
  const setPresence = useSetAtom(setPresenceAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);
  const removeConversation = useSetAtom(removeConversationAtom);

  useEffect(() => {
    const socket = getImSocket();

    const onMessage = (payload: ImMessage) => applyIncomingMessage(payload);
    const onPresence = (payload: PresenceState) => setPresence(payload);
    const onConversationCreated = (payload: ConversationSummary) =>
      upsertConversation(payload);
    const onConversationRemoved = (payload: { conversationId: string }) =>
      removeConversation(payload.conversationId);

    socket.on(IM_WS_EVENTS.message, onMessage);
    socket.on(IM_WS_EVENTS.presence, onPresence);
    socket.on(IM_WS_EVENTS.conversationCreated, onConversationCreated);
    socket.on(IM_WS_EVENTS.conversationRemoved, onConversationRemoved);

    return () => {
      socket.off(IM_WS_EVENTS.message, onMessage);
      socket.off(IM_WS_EVENTS.presence, onPresence);
      socket.off(IM_WS_EVENTS.conversationCreated, onConversationCreated);
      socket.off(IM_WS_EVENTS.conversationRemoved, onConversationRemoved);
    };
  }, [
    applyIncomingMessage,
    setPresence,
    upsertConversation,
    removeConversation,
  ]);
}
