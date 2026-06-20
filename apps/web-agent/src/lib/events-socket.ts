"use client";

import { EVENTS_WS_NAMESPACE } from "@meshbot/types";
import { getAccessToken, getBrowserApiBaseUrl } from "@meshbot/web-common";
import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * 获取全局事件总线 namespace 的 socket.io 单例。
 *
 * 握手时带本地 JWT token；socket.io-client 默认自动重连。
 * 连接 URL = API base + /ws/events namespace。
 */
export function getEventsSocket(): Socket {
  if (socket) return socket;
  const base = getBrowserApiBaseUrl();
  socket = io(`${base}/${EVENTS_WS_NAMESPACE}`, {
    transports: ["websocket"],
    auth: { token: getAccessToken() ?? "" },
    autoConnect: true,
  });
  return socket;
}

/** 断开并清空全局事件总线 socket 单例。 */
export function disconnectEventsSocket(): void {
  socket?.disconnect();
  socket = null;
}
