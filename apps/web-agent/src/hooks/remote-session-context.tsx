"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { answerRemote, confirmRemote } from "@/rest/remote-devices";

/** 远程会话控制器：深层 HITL 卡片消费的最小闭包集合。 */
type RemoteSession = {
  remoteDeviceId: string;
  confirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  answer: (
    toolCallId: string,
    answers: { selected: string[]; other?: string }[],
  ) => Promise<void>;
};

const Ctx = createContext<RemoteSession | null>(null);

/**
 * 远程会话上下文：让深层的 HITL 卡片拿到 remoteDeviceId 与「点击时的实时
 * streamId」，走远程控制端点。本地会话不包这个 Provider，useRemoteSession
 * 返回 null。
 */
export function RemoteSessionProvider(props: {
  remoteDeviceId: string;
  sessionId: string;
  getStreamId: () => string | null;
  children: ReactNode;
}) {
  const { remoteDeviceId, sessionId, getStreamId, children } = props;
  const value = useMemo<RemoteSession>(
    () => ({
      remoteDeviceId,
      confirm: async (toolCallId, decision, content) => {
        const streamId = getStreamId();
        if (!streamId) return;
        await confirmRemote(remoteDeviceId, {
          streamId,
          sessionId,
          toolCallId,
          decision,
          content,
        });
      },
      answer: async (toolCallId, answers) => {
        const streamId = getStreamId();
        if (!streamId) return;
        await answerRemote(remoteDeviceId, {
          streamId,
          sessionId,
          toolCallId,
          answers,
        });
      },
    }),
    [remoteDeviceId, sessionId, getStreamId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 卡片消费：远程会话返回控制器，本地会话返回 null。 */
export function useRemoteSession(): RemoteSession | null {
  return useContext(Ctx);
}
