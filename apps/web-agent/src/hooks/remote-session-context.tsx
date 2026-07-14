"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * 远程会话控制器：深层组件（产物预览卡 / 嵌套子代理卡）消费的最小闭包集合。
 *
 * confirm/answer 已随 Task 8 HITL 收敛移除——四个 HITL 卡（im_send_message/
 * ask_question/drive_share/drive_create_share）现在统一走 props 化的
 * onConfirm/onAnswer（`message-list.tsx` → `tool-call-block.tsx` 一路透传
 * `useSessionStream().confirm/answer`，本地/远程分支已下沉在
 * SessionTransport 内部），不再经本 context 取 confirm/answer。
 */
type RemoteSession = {
  remoteDeviceId: string;
  /** B 设备上的会话 id（跨设备产物预览等按会话校验的请求用）。 */
  sessionId: string;
};

const Ctx = createContext<RemoteSession | null>(null);

/**
 * 远程会话上下文：让深层组件（产物预览卡 / 嵌套子代理卡）拿到
 * remoteDeviceId/sessionId，据此选择跨设备查询通道 / transport。本地会话不包
 * 这个 Provider，useRemoteSession 返回 null。
 */
export function RemoteSessionProvider(props: {
  remoteDeviceId: string;
  sessionId: string;
  children: ReactNode;
}) {
  const { remoteDeviceId, sessionId, children } = props;
  const value = useMemo<RemoteSession>(
    () => ({ remoteDeviceId, sessionId }),
    [remoteDeviceId, sessionId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 卡片消费：远程会话返回控制器，本地会话返回 null。 */
export function useRemoteSession(): RemoteSession | null {
  return useContext(Ctx);
}
