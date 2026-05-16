import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";

/**
 * Socket.io 握手期 trace middleware —— Phase 6 D2。
 *
 * 写入 `socket.data.traceId`：优先取上游 `x-trace-id` header（透传链路追踪），
 * 否则随机生成 UUID。`WsExceptionFilter` 出错时把 traceId 带入 envelope。
 *
 * 用法（gateway `afterInit`）：
 * ```ts
 * server.use(wsTraceMiddleware);
 * ```
 */
export function wsTraceMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): void {
  const headerTrace = socket.handshake.headers["x-trace-id"];
  const authTrace = (socket.handshake.auth as { traceId?: unknown })?.traceId;
  const incoming =
    typeof headerTrace === "string" && headerTrace.length > 0
      ? headerTrace
      : typeof authTrace === "string" && authTrace.length > 0
        ? authTrace
        : undefined;
  socket.data.traceId = incoming ?? randomUUID();
  next();
}
