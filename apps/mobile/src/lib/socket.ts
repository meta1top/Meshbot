import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * 惰性创建 socket.io 客户端(stub)。`autoConnect: false` —— 本期仅立约定,不建活连接。
 *
 * @public-api 数据层预铺 stub,供后续接入实时通道时引用,当前暂无调用方。
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(process.env.EXPO_PUBLIC_API_BASE_URL ?? "", {
      autoConnect: false,
    });
  }
  return socket;
}
