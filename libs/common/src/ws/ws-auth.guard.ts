import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { WsException } from "@nestjs/websockets";
import type { Socket } from "socket.io";

import { AppError } from "../errors/app.error";
import { CommonErrorCode } from "../errors/common.error-codes";

/**
 * WebSocket 鉴权 Guard —— Phase 6 D1。
 *
 * 读取 `client.data.user`（由 `createWsJwtMiddleware` 在 handshake 期写入）。
 * 未鉴权时抛 `WsException`，包一个 `AppError(UNAUTHORIZED)`，
 * 由 `WsExceptionFilter` 统一格式化 → 客户端收 envelope + disconnect。
 *
 * 不直接依赖 `JwtService`，避免业务方 token 算法 / payload 形态强耦合。
 * JWT verify 在 handshake middleware 层完成（业务方提供 verify 回调）。
 */
@Injectable()
export class WsAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const client = ctx.switchToWs().getClient<Socket>();
    if (!client.data?.user) {
      throw new WsException(new AppError(CommonErrorCode.UNAUTHORIZED));
    }
    return true;
  }
}
