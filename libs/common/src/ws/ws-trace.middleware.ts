import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";

/**
 * 合法 traceId 格式：字母数字 + `.` `_` `-`，1-128 字符。
 *
 * 上游 traceId 完全由客户端可控，会被回显进 error envelope 与服务端日志
 * （`WsExceptionFilter`）。无校验则可注入超长字符串 / 换行 / 控制字符，
 * 造成日志注入与膨胀。不匹配此白名单的上游值一律丢弃，改用随机 UUID。
 */
const TRACE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function sanitizeTraceId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return TRACE_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Socket.io 握手期 trace middleware —— Phase 6 D2。
 *
 * 写入 `socket.data.traceId`：优先取上游 `x-trace-id` header（透传链路追踪），
 * 否则随机生成 UUID。上游值须通过格式白名单校验，否则丢弃改用 UUID
 * （防日志注入）。`WsExceptionFilter` 出错时把 traceId 带入 envelope。
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
  const incoming =
    sanitizeTraceId(socket.handshake.headers["x-trace-id"]) ??
    sanitizeTraceId((socket.handshake.auth as { traceId?: unknown })?.traceId);
  socket.data.traceId = incoming ?? randomUUID();
  next();
}
