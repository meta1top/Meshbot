import type { WsExceptionFilter as NestWsExceptionFilter } from "@nestjs/common";
import { type ArgumentsHost, Catch, Logger } from "@nestjs/common";
import { WsException } from "@nestjs/websockets";
// biome-ignore lint/style/useImportType: I18nService 需要运行期 import 以参与 Nest DI 元数据
import { I18nContext, I18nService } from "nestjs-i18n";
import type { Socket } from "socket.io";

import { AppError } from "../errors/app.error";
import { formatEnvelope, httpStatusFor } from "../errors/format-envelope";

/**
 * WebSocket 异常 Filter —— Phase 6 D1。
 *
 * 与 HTTP `ErrorsFilter` 形成对称：复用 `formatEnvelope` 拼装统一 envelope，
 * 通过 `client.emit("exception", envelope)` 推给客户端；
 * 401（UNAUTHORIZED）主动 disconnect，阻止后续订阅 / 消息消耗资源。
 *
 * 事件名采用 `exception`，对齐 NestJS 内置 WS 异常 filter 的约定；不用 `error`
 * 因为 socket.io 客户端对 `error` 有特殊处理（保留事件名）。
 *
 * 同时拆 `WsException` 的内层（业务方习惯 `new WsException(new AppError(...))`），
 * 把内层错误透传给 `formatEnvelope`，保留原 errorCode。
 */
@Catch()
export class WsExceptionFilter implements NestWsExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== "ws") return;
    const client = host.switchToWs().getClient<Socket>();
    const traceId =
      typeof client.data?.traceId === "string"
        ? client.data.traceId
        : undefined;
    const lang = I18nContext.current()?.lang ?? "zh";

    // 拆 WsException 内核：业务通常抛 new WsException(new AppError(...))
    const inner =
      exception instanceof WsException ? exception.getError() : exception;

    const envelope = formatEnvelope(inner, {
      lang,
      path: "",
      traceId,
      i18n: this.i18n,
    });

    const status = httpStatusFor(inner);
    if (status >= 500) {
      this.logger.error(
        `ws://${client.nsp?.name ?? "?"} → ${envelope.code} ${envelope.message}`,
        inner instanceof Error ? inner.stack : undefined,
      );
    }

    client.emit("exception", envelope);

    // 401 → 主动断开；避免 client 在未鉴权状态长连接消耗资源
    if (inner instanceof AppError && inner.errorCode.httpStatus === 401) {
      client.disconnect(true);
    }
  }
}
