import { SESSION_WS_NAMESPACE } from "@meshbot/types-agent";
import { getAccessToken, getBrowserApiBaseUrl } from "@meshbot/web-common";
import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * 获取会话 namespace 的 socket.io 单例。
 *
 * 握手时带 JWT token；socket.io-client 默认自动重连。
 * 连接 URL = API base + /ws/session namespace。
 */
export function getSessionSocket(): Socket {
  if (socket) return socket;
  const base = getBrowserApiBaseUrl();
  socket = io(`${base}/${SESSION_WS_NAMESPACE}`, {
    transports: ["websocket"],
    auth: { token: getAccessToken() ?? "" },
    autoConnect: true,
  });
  return socket;
}

/** 断开并清空 socket 单例。 */
export function disconnectSessionSocket(): void {
  socket?.disconnect();
  socket = null;
}
