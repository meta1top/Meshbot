import { IM_WS_NAMESPACE } from "@meshbot/types";
import { io, type Socket } from "socket.io-client";
import { getMainToken } from "./auth-storage";

/**
 * web-main 云协同前端的 IM WebSocket 单例连接（直连 server-main `/ws/im`）。
 *
 * 与 web-agent 的 ws/events 信封总线彻底隔离：这里订阅的是 `IM_WS_EVENTS.*` 原生事件，
 * 鉴权走浏览器用户 JWT（`getMainToken`），不是设备 token。
 *
 * L3（`device.query.*` / `agent.run.*` 六个事件）也复用这同一条连接：浏览器用户
 * 是 L3 协议里的发起方（A），`im.gateway.ts` 的 `RunRequester` kind:"user" 分支
 * 按 `socket.id` 直发定向下发（无 device room 语义）。事件的注册/派发逻辑见
 * `session-transport.ts` 的 `createRemoteSessionTransport`，本文件只负责连接本身。
 */
let socket: Socket | null = null;

/** 取（并按需建立）ws/im 连接；同进程内复用同一个 socket 实例。 */
export function getImSocket(): Socket {
  if (socket) return socket;
  const base = process.env.NEXT_PUBLIC_SERVER_MAIN_URL ?? "";
  socket = io(`${base}/${IM_WS_NAMESPACE}`, {
    transports: ["websocket"],
    auth: { token: getMainToken() ?? "" },
    autoConnect: true,
  });
  return socket;
}

/** 断开并清空当前连接（登出 / 切组织后调用，避免残留旧 token 的连接）。 */
export function disconnectImSocket(): void {
  socket?.disconnect();
  socket = null;
}
