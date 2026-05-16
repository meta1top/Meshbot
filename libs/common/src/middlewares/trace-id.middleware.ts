import { randomUUID } from "node:crypto";

/**
 * Trace ID 中间件 —— Phase 5 Track B2。
 *
 * 行为：
 * - 如果请求带 `x-trace-id` header（上游网关 / 反代 / 调用方注入）→ 透传
 * - 否则生成新 UUID
 * - 写入 `req.traceId` 供后续 interceptor / filter / logger 取用
 * - 同时回写到 `x-trace-id` response header（客户端可对账）
 *
 * 注册方式（server-agent / server-main `main.ts`）：
 * ```ts
 * app.use(traceIdMiddleware);
 * ```
 *
 * 与 `ResponseInterceptor` / `ErrorsFilter` 联动：两者从 `req.traceId` 取值
 * 写入响应 envelope 的 `traceId` 字段；前端 / 调用方按此追溯日志。
 *
 * 未来扩展（Phase 6+）：可切换到 OTel propagation 标准（`traceparent` header）。
 */
interface MaybeTraced {
  headers?: Record<string, string | string[] | undefined>;
  traceId?: string;
}
interface MaybeResponse {
  setHeader(name: string, value: string): unknown;
}

export const TRACE_ID_HEADER = "x-trace-id";

export function traceIdMiddleware(
  req: MaybeTraced,
  res: MaybeResponse,
  next: () => void,
): void {
  const incoming = req.headers?.[TRACE_ID_HEADER];
  const traceId =
    typeof incoming === "string" && incoming.length > 0
      ? incoming
      : Array.isArray(incoming) && incoming[0]
        ? incoming[0]
        : randomUUID();
  req.traceId = traceId;
  res.setHeader(TRACE_ID_HEADER, traceId);
  next();
}
