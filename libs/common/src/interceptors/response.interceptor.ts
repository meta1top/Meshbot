import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from "@nestjs/common";
// biome-ignore lint/style/useImportType: Reflector 必须值导入，NestJS 构造器 DI 用得到运行时类引用
import { Reflector } from "@nestjs/core";
import { map, type Observable } from "rxjs";

import { CommonErrorCode } from "../errors/common.error-codes";

/** 跳过 ResponseInterceptor 包装的元数据标记 */
export const SKIP_RESPONSE_ENVELOPE = Symbol("SKIP_RESPONSE_ENVELOPE");

/**
 * 端点 / controller 类级别跳过统一响应 envelope。
 *
 * 适用：
 * - Health / metrics 端点（Terminus 自带 shape）
 * - Swagger UI
 * - 流式（SSE / WebSocket）
 * - OAuth redirect（手动 `@Res()`）
 *
 * ```ts
 * @SkipResponseEnvelope()
 * @Get("health") check() { ... }
 * ```
 */
export const SkipResponseEnvelope = () =>
  SetMetadata(SKIP_RESPONSE_ENVELOPE, true);

interface SuccessEnvelope<T> {
  success: true;
  code: 0;
  message: "success";
  data: T;
  timestamp: string;
  path: string;
  traceId?: string;
}

interface HttpRequestLike {
  url?: string;
  traceId?: string;
}

/**
 * 全局响应 Interceptor —— Phase 5 Track A3。
 *
 * 把 controller 的 return 包装成统一 envelope：
 *
 * ```json
 * {
 *   "success": true,
 *   "code": 0,
 *   "message": "success",
 *   "data": <return value>,
 *   "timestamp": "...",
 *   "path": "/api/...",
 *   "traceId": "..."
 * }
 * ```
 *
 * 失败 envelope 由 `ErrorsFilter` 输出，shape 对齐（success / code / message /
 * data / timestamp / path / traceId）。前端单一 unwrap 逻辑即可。
 *
 * `@SkipResponseEnvelope()` 标记的端点 / controller 类原样返回。
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_RESPONSE_ENVELOPE,
      [context.getHandler(), context.getClass()],
    );
    if (skip) return next.handle();

    const req = context.switchToHttp().getRequest<HttpRequestLike>();
    return next.handle().pipe(
      map(
        (data): SuccessEnvelope<unknown> => ({
          success: true,
          code: CommonErrorCode.SUCCESS.code as 0,
          message: "success",
          data: data ?? null,
          timestamp: new Date().toISOString(),
          path: req.url ?? "",
          traceId: req.traceId,
        }),
      ),
    );
  }
}
