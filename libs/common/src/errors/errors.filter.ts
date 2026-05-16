import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Logger,
} from "@nestjs/common";
import { I18nContext, type I18nService } from "nestjs-i18n";

import { formatEnvelope, httpStatusFor } from "./format-envelope";

interface HttpResponseLike {
  status(code: number): this;
  json(body: unknown): unknown;
}

interface HttpRequestLike {
  url?: string;
  traceId?: string;
}

/**
 * 全局异常 Filter —— Phase 5 Track A2。
 *
 * 兜底所有 throw（`@Catch()` 无参数）。envelope 形态见 `format-envelope.ts`。
 *
 * Phase 6 D1：envelope formatting 抽出到 `formatEnvelope` 供 WS 共用，
 * 本 filter 只负责 HTTP 出口适配（取 req/res、决定 status code、写 5xx 日志）。
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorsFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    // 仅处理 HTTP 上下文；WS / RPC 由各自 filter 处理
    if (host.getType() !== "http") return;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<HttpRequestLike>();
    const res = ctx.getResponse<HttpResponseLike>();
    const lang = I18nContext.current()?.lang ?? "zh";

    const envelope = formatEnvelope(exception, {
      lang,
      path: req.url ?? "",
      traceId: req.traceId,
      i18n: this.i18n,
    });

    const httpStatus = httpStatusFor(exception);
    if (httpStatus >= 500) {
      this.logger.error(
        `${req.url ?? "?"} → ${envelope.code} ${envelope.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    res.status(httpStatus).json(envelope);
  }
}
