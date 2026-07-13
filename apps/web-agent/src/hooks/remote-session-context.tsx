"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

/** 远程会话控制器：深层 HITL 卡片消费的最小闭包集合。 */
type RemoteSession = {
  remoteDeviceId: string;
  /** B 设备上的会话 id（跨设备产物预览等按会话校验的请求用）。 */
  sessionId: string;
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
 * 远程会话上下文：让深层的 HITL 卡片拿到 remoteDeviceId/sessionId 与
 * confirm/answer 闭包。confirm/answer 由调用方直接传入
 * `useSessionStream` 返回的 `stream.confirm`/`stream.answer`（内部已经过
 * SessionTransport 路由 + 「点击时的实时 streamId」现取，见
 * use-session-stream.ts），本组件不再自行拼装远程端点调用。本地会话不包这个
 * Provider，useRemoteSession 返回 null。
 */
export function RemoteSessionProvider(props: {
  remoteDeviceId: string;
  sessionId: string;
  confirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  answer: (
    toolCallId: string,
    answers: { selected: string[]; other?: string }[],
  ) => Promise<void>;
  children: ReactNode;
}) {
  const { remoteDeviceId, sessionId, confirm, answer, children } = props;
  const value = useMemo<RemoteSession>(
    () => ({ remoteDeviceId, sessionId, confirm, answer }),
    [remoteDeviceId, sessionId, confirm, answer],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 卡片消费：远程会话返回控制器，本地会话返回 null。 */
export function useRemoteSession(): RemoteSession | null {
  return useContext(Ctx);
}
